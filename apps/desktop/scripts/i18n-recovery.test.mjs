import { createGitAdapter } from './i18n-git.mts'
import { runI18nCli } from './check-i18n.mts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
    analyzeCommittedHistory,
    analyzeWorkingTree,
    analyzeProspective,
    summarizeHistory,
    describeHistoryAvailability,
    snapshotFromBundles,
} from './i18n-history.mts'
import { PENDING_PROVENANCE } from './i18n-history-events.mts'
import { synchronizeI18n, planI18nSync } from './i18n-sync.mts'
import { prepareI18nReview, applyReviewAction, buildReviewCandidates } from './i18n-review.mts'
import { checkI18nSemantics, checkStagedI18n } from './i18n-enforcement.mts'

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function fixture(t, states) {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-recovery-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.name', 'Recovery Test'])
    git(cwd, ['config', 'user.email', 'recovery@example.test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(cwd, 'i18n'))
    const revisions = []
    for (const [index, state] of states.entries()) {
        for (const [locale, bundle] of Object.entries(state))
            writeFileSync(
                join(cwd, 'i18n', locale + '.json'),
                typeof bundle === 'string' ? bundle : JSON.stringify(bundle)
            )
        git(cwd, ['add', '-A'])
        git(cwd, ['commit', '-qm', 'revision ' + index])
        revisions.push(git(cwd, ['rev-parse', 'HEAD']))
    }
    return { cwd, baseline: revisions[0], localeDir: 'i18n', revisions }
}
function entry(history, locale = 'de') {
    return summarizeHistory(history).locales.get(locale).entries.get('a')
}
const baseline = { en: { a: 'A' }, de: { a: 'X' }, it: { a: 'Y' } }

test('a broken locale does not erase readable source and other locale acceptance', (t) => {
    const options = fixture(t, [
        baseline,
        { en: { a: 'B' }, de: '{', it: { a: 'Z' } },
        { en: { a: 'C' }, de: { a: 'X' }, it: { a: 'Z' } },
    ])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history, 'it').effectiveState, 'review')
    assert.equal(entry(history, 'it').checkpoint.sourceText, 'B')
    assert.equal(entry(history, 'it').checkpoint.revision, options.revisions[1])
    assert.deepEqual(entry(history, 'it').gapIds, [])
    assert.equal(entry(history).effectiveProvenance, 'history-gap')
    assert.equal(entry(history).checkpoint.revision, options.baseline)
    assert.equal(history.gaps[0].locale, 'de')
    assert.equal(history.snapshot.revision, options.revisions.at(-1))
})

for (const recovered of ['X', 'Z', '? X']) {
    test('repair to ' + recovered + ' does not fabricate acceptance', (t) => {
        const options = fixture(t, [
            baseline,
            { en: { a: 'B' }, de: '{' },
            { en: { a: 'C' }, de: { a: recovered } },
        ])
        const history = analyzeCommittedHistory(options)
        assert.equal(entry(history).effectiveState, 'review')
        assert.equal(entry(history).lastProvenCheckpoint.revision, options.baseline)
        assert.ok(entry(history).gapIds.length > 0)
        assert.equal(
            history.events.some(
                (event) => event.locale === 'de' && event.revision === options.revisions[2]
            ),
            false
        )
    })
}

test('same-source repair remains Review until a later observable acceptance', (t) => {
    const options = fixture(t, [baseline, { de: '{' }, { de: { a: 'X' } }, { de: { a: 'Z' } }])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).effectiveState, 'accepted')
    assert.equal(entry(history).checkpoint.revision, options.revisions[3])
    assert.deepEqual(entry(history).gapIds, [])
    assert.equal(history.gaps.length, 1)
})

test('source return cannot clear identical Pending endpoints across a gap', (t) => {
    const options = fixture(t, [
        baseline,
        { en: { a: 'B' }, de: { a: '? X' } },
        { de: '{' },
        { de: { a: '? X' } },
        { en: { a: 'A' } },
    ])
    const history = analyzeCommittedHistory(options)
    const target = entry(history)
    assert.equal(target.acceptedPairSeen, true)
    assert.equal(target.effectiveState, 'review')
    assert.equal(target.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
    assert.throws(
        () => planI18nSync({ history, sourceBundle: { a: 'A' } }),
        /Insufficient historical evidence/
    )
})

test('unreadable English scopes a gap to every dependent target', (t) => {
    const options = fixture(t, [baseline, { en: '{', de: { a: 'Z' } }, { en: { a: 'B' } }])
    const history = analyzeCommittedHistory(options)
    for (const locale of ['de', 'it']) {
        assert.equal(entry(history, locale).effectiveState, 'review')
        assert.ok(entry(history, locale).gapIds.length > 0)
        assert.equal(entry(history, locale).checkpoint.revision, options.baseline)
    }
    assert.equal(history.gaps[0].locale, 'en')
})

for (const recovered of ['! B', undefined, '? X']) {
    test('gap-backed scaffold, absence, or Pending has truthful state: ' + recovered, (t) => {
        const options = fixture(t, [
            { en: { a: 'A' }, de: { a: '! A' } },
            { en: '{', de: { a: '? X' } },
            { en: { a: 'B' }, de: recovered === undefined ? {} : { a: recovered } },
        ])
        const history = analyzeCommittedHistory(options)
        assert.equal(entry(history).effectiveState, recovered === '? X' ? 'review' : 'missing')
        assert.equal(entry(history).checkpoint, null)
        if (recovered === '? X') {
            const candidate = prepareI18nReview({ ...options, localeId: 'de' }).candidates[0]
            assert.equal(candidate.lastAcceptedSourceText, null)
            assert.equal(candidate.checkpointRevision, null)
        }
    })
}

for (const corruptAt of ['baseline', 'latest']) {
    test('corrupt ' + corruptAt + ' revision refuses authoritative current results', (t) => {
        const states =
            corruptAt === 'baseline'
                ? [{ en: { a: 'A' }, de: '{' }, baseline]
                : [baseline, { de: '{' }]
        const options = fixture(t, states)
        assert.throws(() => analyzeCommittedHistory(options), /Failed to parse de.json/)
    })
}

for (const target of ['X', '? X']) {
    test(
        'insufficient placeholder provenance refuses semantics, staged checks, and every sync write: ' +
            target,
        (t) => {
            const options = fixture(t, [
                baseline,
                { de: '{' },
                { en: { a: 'B {name}' }, de: { a: target } },
            ])
            let writes = 0
            const before = readFileSync(join(options.cwd, 'i18n/de.json'), 'utf8')
            assert.throws(() => checkI18nSemantics(options), /Insufficient historical evidence/)
            assert.throws(
                () =>
                    synchronizeI18n({
                        ...options,
                        write: () => {
                            writes++
                        },
                    }),
                /Insufficient historical evidence/
            )
            assert.equal(writes, 0)
            assert.equal(readFileSync(join(options.cwd, 'i18n/de.json'), 'utf8'), before)
            writeFileSync(
                join(options.cwd, 'i18n/de.json'),
                JSON.stringify({ a: target }, null, 4) + '\n'
            )
            git(options.cwd, ['add', 'i18n/de.json'])
            writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: 'Y {name}' }))
            assert.throws(() => checkStagedI18n(options), /Insufficient historical evidence/)
            assert.equal(entry(analyzeWorkingTree(options)).effectiveState, 'accepted')
        }
    )
}

test('an explicit committed review marker resolves a gap without automatic marker writes', (t) => {
    const options = fixture(t, [baseline, { de: '{' }, { en: { a: 'B' }, de: { a: 'X' } }])
    const before = prepareI18nReview({ ...options, localeId: 'de' }).candidates[0]
    assert.throws(() => applyReviewAction(before, 'keep'), /explicit review marker/)
    assert.throws(() => synchronizeI18n(options), /Insufficient historical evidence/)
    writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: '? X' }))
    const uncommitted = prepareI18nReview({ ...options, localeId: 'de' }).candidates[0]
    assert.throws(() => applyReviewAction(uncommitted, 'keep'), /no acceptance could be recorded/)
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'request explicit review'])
    const candidate = prepareI18nReview({ ...options, localeId: 'de' }).candidates[0]
    const kept = applyReviewAction(candidate, 'keep')
    writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: kept.storedValue }))
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'accept current English'])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).effectiveState, 'accepted')
    assert.equal(entry(history).checkpoint.sourceText, 'B')
    assert.deepEqual(entry(history).gapIds, [])
    synchronizeI18n(options)
    assert.deepEqual(synchronizeI18n(options).written, [])
})

test('normalization cannot resolve a history gap but a later translated edit can', (t) => {
    const options = fixture(t, [
        { en: { a: 'A' }, de: { a: '\u00e9' } },
        { de: '{' },
        { en: { a: 'B' }, de: { a: '\u00e9' } },
    ])
    const candidate = prepareI18nReview({ ...options, localeId: 'de' }).candidates[0]
    assert.equal(candidate.evidenceIncomplete, true)
    assert.throws(
        () => applyReviewAction(candidate, 'edit', 'e\u0301'),
        /canonically identical.*explicit review marker/
    )
    assert.throws(() => applyReviewAction(candidate, 'keep'), /explicit review marker/)
    const edited = applyReviewAction(candidate, 'edit', 'Y')
    writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: edited.storedValue }))
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'translate current source'])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).effectiveState, 'accepted')
    assert.equal(entry(history).checkpoint.sourceText, 'B')
    assert.equal(entry(history).checkpoint.rawTargetText, 'Y')
    assert.deepEqual(entry(history).gapIds, [])
})

test('invalid UTF-8 historical evidence is scoped and a repair creates no acceptance', (t) => {
    const options = fixture(t, [baseline])
    writeFileSync(join(options.cwd, 'i18n/de.json'), Buffer.from([0xc3, 0x28]))
    writeFileSync(join(options.cwd, 'i18n/it.json'), JSON.stringify({ a: 'Z' }))
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'unreadable target'])
    const italianAcceptance = git(options.cwd, ['rev-parse', 'HEAD'])
    writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: 'X' }))
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'repair'])
    const history = analyzeCommittedHistory(options)
    assert.equal(history.gaps[0].kind, 'invalid-utf8')
    assert.equal(entry(history).effectiveState, 'review')
    assert.equal(entry(history, 'it').effectiveState, 'accepted')
    assert.equal(entry(history, 'it').checkpoint.revision, italianAcceptance)
})

test('requested HEAD identity includes unrelated commits after a readable recovery', (t) => {
    const options = fixture(t, [baseline, { de: '{' }, { de: { a: 'X' } }])
    writeFileSync(join(options.cwd, 'unrelated'), 'content')
    git(options.cwd, ['add', '-A'])
    git(options.cwd, ['commit', '-qm', 'unrelated'])
    const history = analyzeCommittedHistory(options)
    assert.equal(history.revision, git(options.cwd, ['rev-parse', 'HEAD']))
    assert.equal(history.snapshot.revision, history.revision)
    assert.equal(entry(history).effectiveState, 'review')
})

function capture() {
    let value = ''
    return {
        write(text) {
            value += text
        },
        value() {
            return value
        },
    }
}

test('selected check uses semantic history to defer proven source-change placeholder debt', async (t) => {
    const options = fixture(t, [{ en: { a: 'A' }, de: { a: 'X' } }, { en: { a: 'B {name}' } }])
    const stdout = capture(),
        stderr = capture()
    assert.equal(
        await runI18nCli(['de'], {
            ...options,
            i18nDir: join(options.cwd, 'i18n'),
            stdout,
            stderr,
        }),
        0
    )
    assert.match(stdout.value(), /0 accepted, 1 review/)
    assert.equal(stderr.value(), '')
    const explicit = capture()
    assert.equal(
        await runI18nCli(['--locale', 'de'], {
            ...options,
            i18nDir: join(options.cwd, 'i18n'),
            stdout: explicit,
            stderr,
        }),
        0
    )
    assert.equal(explicit.value(), stdout.value())
})

test('selected check and review ignore corrupt unrelated current and latest locale', async (t) => {
    const options = fixture(t, [baseline, { de: '{' }])
    const stdout = capture(),
        stderr = capture()
    const commandOptions = { ...options, i18nDir: join(options.cwd, 'i18n'), stdout, stderr }
    assert.equal(await runI18nCli(['it'], commandOptions), 0)
    assert.match(stdout.value(), /1 accepted, 0 review/)
    assert.equal(prepareI18nReview({ ...options, localeId: 'it' }).candidates.length, 0)
    assert.equal(await runI18nCli([], commandOptions), 1)
    assert.equal(await runI18nCli(['de'], commandOptions), 1)
})

test('selected check reports insufficient evidence without rejecting its promise or writing', async (t) => {
    const options = fixture(t, [
        { en: { a: 'A' }, de: { a: 'X' } },
        { de: '{' },
        { en: { a: 'B {name}' }, de: { a: 'X' } },
    ])
    const stdout = capture(),
        stderr = capture()
    const before = readFileSync(join(options.cwd, 'i18n/de.json'), 'utf8')
    assert.equal(
        await runI18nCli(['de'], {
            ...options,
            i18nDir: join(options.cwd, 'i18n'),
            stdout,
            stderr,
        }),
        1
    )
    assert.match(stderr.value(), /Insufficient historical evidence/)
    assert.equal(readFileSync(join(options.cwd, 'i18n/de.json'), 'utf8'), before)
})

for (const locale of ['en', 'de']) {
    for (const location of ['baseline', 'latest']) {
        test(locale + ' corrupt ' + location + ' fails closed at the history boundary', (t) => {
            const broken = { ...baseline, [locale]: '{' }
            const states = location === 'baseline' ? [broken, baseline] : [baseline, broken]
            const options = fixture(t, states)
            assert.throws(() => analyzeCommittedHistory(options), /Failed to parse/)
        })
    }
}

test('unreadable current UTF-8 cannot become an accepting target edit or reach a writer', async (t) => {
    const options = fixture(t, [baseline])
    const path = join(options.cwd, 'i18n/de.json')
    const bytes = Buffer.concat([
        Buffer.from('{"a":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
    ])
    writeFileSync(path, bytes)
    assert.throws(() => analyzeWorkingTree(options), /Invalid UTF-8 locale file/)
    assert.throws(() => checkI18nSemantics(options), /Invalid UTF-8 locale file/)
    assert.throws(
        () => prepareI18nReview({ ...options, localeId: 'de' }),
        /Invalid UTF-8 locale file/
    )
    let writes = 0
    assert.throws(
        () =>
            synchronizeI18n({
                ...options,
                write() {
                    writes++
                },
            }),
        /Failed to parse locale|Invalid UTF-8/
    )
    assert.equal(writes, 0)
    const stdout = capture(),
        stderr = capture()
    const cli = { ...options, i18nDir: join(options.cwd, 'i18n'), stdout, stderr }
    assert.equal(await runI18nCli(['de'], cli), 1)
    assert.equal(await runI18nCli(['it'], cli), 0)
    assert.deepEqual(readFileSync(path), bytes)
})

test('strict current decoding preserves rejection of a leading JSON byte-order mark', async (t) => {
    const options = fixture(t, [baseline])
    writeFileSync(join(options.cwd, 'i18n/de.json'), '\ufeff' + JSON.stringify({ a: 'X' }))
    assert.throws(() => analyzeWorkingTree(options), /Failed to parse de.json/)
    const stderr = capture()
    assert.equal(
        await runI18nCli(['de'], {
            ...options,
            i18nDir: join(options.cwd, 'i18n'),
            stdout: capture(),
            stderr,
        }),
        1
    )
    assert.match(stderr.value(), /Failed to parse de.json@working-tree/)
})

for (const target of ['X', 'Z', '? X']) {
    test('unresolved compatible history blocks every automatic decision: ' + target, async (t) => {
        const options = fixture(t, [baseline, { de: '{' }, { de: { a: target } }])
        const history = analyzeCommittedHistory(options)
        const checkpoint = entry(history).lastProvenCheckpoint
        assert.equal(checkpoint.revision, options.baseline)
        assert.equal(entry(history).effectiveState, 'review')
        let writes = 0
        const before = readFileSync(join(options.cwd, 'i18n/de.json'))
        assert.throws(
            () => planI18nSync({ history, sourceBundle: { a: 'A' } }),
            /Insufficient historical evidence/
        )
        assert.throws(() => checkI18nSemantics(options), /Insufficient historical evidence/)
        assert.throws(
            () =>
                synchronizeI18n({
                    ...options,
                    write: () => {
                        writes++
                    },
                }),
            /Insufficient historical evidence/
        )
        assert.equal(writes, 0)
        assert.deepEqual(readFileSync(join(options.cwd, 'i18n/de.json')), before)
        writeFileSync(join(options.cwd, 'i18n/de.json'), JSON.stringify({ a: target }, null, 4))
        git(options.cwd, ['add', '-A'])
        assert.throws(() => checkStagedI18n(options), /Insufficient historical evidence/)
        const stdout = capture(),
            stderr = capture()
        assert.equal(
            await runI18nCli(['de'], {
                ...options,
                i18nDir: join(options.cwd, 'i18n'),
                stdout,
                stderr,
            }),
            1
        )
        assert.match(stderr.value(), /Insufficient historical evidence/)
        assert.equal(
            await runI18nCli(['--status'], {
                ...options,
                i18nDir: join(options.cwd, 'i18n'),
                stdout,
                stderr,
            }),
            0
        )
        assert.equal(prepareI18nReview({ ...options, localeId: 'it' }).candidates.length, 0)
    })
}

test('a gap records uncertainty without inventing pending workflow provenance', (t) => {
    const options = fixture(t, [baseline, { de: '{' }, { de: { a: 'X' } }])
    const history = analyzeCommittedHistory(options)
    const target = entry(history)
    assert.equal(target.pendingProvenance, null)
    assert.equal(target.effectiveProvenance, 'history-gap')
    assert.equal(target.lineageCheckpoint, null)
    assert.equal(target.checkpoint.revision, options.baseline)
})

test('a readable target edit during English repair establishes fresh acceptance', (t) => {
    const options = fixture(t, [baseline, { en: '{' }, { en: { a: 'B' }, de: { a: 'Z' } }])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).effectiveState, 'accepted')
    assert.equal(entry(history).checkpoint.sourceText, 'B')
    assert.equal(entry(history).checkpoint.revision, options.revisions[2])
    assert.deepEqual(entry(history).gapIds, [])
    assert.equal(entry(history, 'it').effectiveState, 'review')
    assert.throws(
        () => planI18nSync({ history, sourceBundle: { a: 'B' } }),
        /Insufficient historical evidence/
    )
})

test('new unproven translation across a gap cannot acquire acceptance or bot review markers', (t) => {
    const options = fixture(t, [{ en: { a: 'A' }, de: {} }, { de: '{' }, { de: { a: 'X' } }])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).checkpoint, null)
    assert.equal(entry(history).pendingProvenance, null)
    assert.equal(entry(history).effectiveState, 'review')
    assert.throws(() => synchronizeI18n(options), /Insufficient historical evidence/)
})

test('withdrawal and scaffolds resolve target gaps as Missing without accepting translations', (t) => {
    for (const bundle of [{}, { a: '! A' }]) {
        const options = fixture(t, [baseline, { de: '{' }, { de: bundle }])
        const history = analyzeCommittedHistory(options)
        assert.equal(entry(history).effectiveState, 'missing')
        assert.deepEqual(entry(history).gapIds, [])
        assert.equal(checkI18nSemantics(options).pass, true)
        assert.equal(
            planI18nSync({ history, sourceBundle: { a: 'A' } })
                .locales.find((l) => l.id === 'de')
                .operations.some((o) => o.kind === 'review-requested'),
            false
        )
    }
})

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const italianHistoryAvailable = describeHistoryAvailability({
    cwd: repository,
    revision: 'faadbd874e6ec0f11a2b86176fe363327c667305',
}).available

test(
    'audited Italian syntax recovery preserves actual acceptance and plans zero marker changes',
    { skip: !italianHistoryAvailable },
    () => {
        const revision = 'faadbd874e6ec0f11a2b86176fe363327c667305'
        const options = { cwd: repository, revision, localeId: 'it' }
        const directory = 'apps/desktop/src/renderer/src/i18n'
        const originalRevision = 'edd784fdcf4cd9e1c849a0f2196dfd32361345af'
        const repairRevision = 'da1040c9f04d7e004d5cd1fee3af15fabaa80b7e'
        const original = execFileSync(
            'git',
            ['show', originalRevision + ':' + directory + '/it.json'],
            { cwd: repository, encoding: 'utf8' }
        )
        const repaired = execFileSync(
            'git',
            ['show', repairRevision + ':' + directory + '/it.json'],
            { cwd: repository, encoding: 'utf8' }
        )
        assert.equal(
            original.replace(
                '"loadFailed": "Impossibile caricare le mod,',
                '"loadFailed": "Impossibile caricare le mod",'
            ),
            repaired
        )
        const sourceAt = (rev) =>
            execFileSync('git', ['show', rev + ':' + directory + '/en.json'], {
                cwd: repository,
                encoding: 'utf8',
            })
        assert.equal(sourceAt(originalRevision), sourceAt(repairRevision))
        const history = analyzeCommittedHistory(options)
        assert.deepEqual(history.gaps, [])
        assert.deepEqual(history.recoveries, [
            {
                locale: 'it',
                revision: originalRevision,
                path: directory + '/it.json',
                blob: 'bb6f61129dfbd7c8bdb1b114b937711e3cfb7645',
                repairedBlob: 'd57d12bbdd1e78537dcbd559bc5c0552e8ff1908',
                repairRevision,
            },
        ])
        assert.deepEqual(summarizeHistory(history).locales.get('it').effective, {
            accepted: 416,
            review: 0,
            missing: 68,
        })
        assert.deepEqual(
            planI18nSync({ history, sourceBundle: JSON.parse(sourceAt(revision)) }).locales[0]
                .operations,
            []
        )
        const altered = createGitAdapter({ cwd: repository })
        const observations = altered.readBlobObservations.bind(altered)
        altered.readBlobObservations = (ids) => {
            const result = observations(ids)
            const damaged = 'bb6f61129dfbd7c8bdb1b114b937711e3cfb7645'
            if (result.has(damaged))
                result.set(damaged, original.replace('Impossibile caricare', 'Changed translation'))
            return result
        }
        assert.throws(
            () => analyzeCommittedHistory({ ...options, git: altered }),
            /does not match its blob identity/
        )
        const corruptLatest = createGitAdapter({ cwd: repository })
        const trees = corruptLatest.treesAtRevisions.bind(corruptLatest)
        corruptLatest.treesAtRevisions = (revisions, path) => {
            const result = trees(revisions, path)
            result
                .get(revisions.at(-1))
                .set(directory + '/it.json', 'bb6f61129dfbd7c8bdb1b114b937711e3cfb7645')
            return result
        }
        assert.throws(
            () => analyzeCommittedHistory({ ...options, git: corruptLatest }),
            /Failed to parse it.json/
        )
        const atRepair = analyzeCommittedHistory({ ...options, revision: repairRevision })
        assert.deepEqual(summarizeHistory(atRepair).locales.get('it').effective, {
            accepted: 424,
            review: 0,
            missing: 0,
        })
        const expected = snapshotFromBundles(originalRevision, {
            en: JSON.parse(sourceAt(originalRevision)),
            it: JSON.parse(repaired),
        })
        for (const [key, target] of summarizeHistory(atRepair).locales.get('it').entries) {
            assert.equal(target.checkpoint.revision, originalRevision)
            assert.equal(target.checkpoint.rawSourceText, expected.source.get(key))
            assert.equal(
                target.checkpoint.rawTargetText,
                expected.locales.get('it').targets.get(key).targetText
            )
        }
        const prospective = snapshotFromBundles('candidate', {
            en: {
                ...JSON.parse(sourceAt(revision)),
                common: { ...JSON.parse(sourceAt(revision)).common, beta: 'New source {name}' },
            },
            it: JSON.parse(
                execFileSync('git', ['show', revision + ':' + directory + '/it.json'], {
                    cwd: repository,
                    encoding: 'utf8',
                })
            ),
        })
        const changed = analyzeProspective(history, prospective)
        const debt = summarizeHistory(changed).locales.get('it').entries.get('common.beta')
        assert.equal(debt.effectiveState, 'review')
        assert.equal(debt.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.deepEqual(debt.gapIds, [])
        const candidates = buildReviewCandidates(changed, 'it', history.snapshot)
        assert.equal(candidates.length, 1)
        assert.equal(candidates[0].key, 'common.beta')
        assert.equal(candidates[0].checkpointRevision, originalRevision)
        assert.equal(candidates[0].lastAcceptedSourceText, debt.checkpoint.rawSourceText)
        assert.equal(candidates[0].lastAcceptedTargetText, debt.checkpoint.rawTargetText)
        assert.equal(candidates[0].evidenceIncomplete, false)
        assert.deepEqual(
            planI18nSync({
                history: changed,
                sourceBundle: {
                    ...JSON.parse(sourceAt(revision)),
                    common: { ...JSON.parse(sourceAt(revision)).common, beta: 'New source {name}' },
                },
            }).locales[0].operations,
            [{ kind: 'review-requested', locale: 'it', key: 'common.beta' }]
        )
        assert.throws(
            () => analyzeCommittedHistory({ ...options, revision: originalRevision }),
            /Failed to parse it.json/
        )
        assert.throws(
            () =>
                analyzeCommittedHistory({
                    ...options,
                    baseline: originalRevision,
                    revision: repairRevision,
                }),
            /Failed to parse it.json/
        )
    }
)

test('marker removal during English repair is a visible acceptance against the readable source', (t) => {
    const options = fixture(t, [
        baseline,
        { en: '{', de: { a: '? X' } },
        { en: { a: 'B' }, de: { a: 'X' } },
    ])
    const history = analyzeCommittedHistory(options)
    assert.equal(entry(history).effectiveState, 'accepted')
    assert.equal(entry(history).checkpoint.sourceText, 'B')
    assert.equal(entry(history).checkpoint.revision, options.revisions[2])
    assert.deepEqual(entry(history).gapIds, [])
})

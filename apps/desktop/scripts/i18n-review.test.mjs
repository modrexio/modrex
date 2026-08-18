import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    parseTargetValue,
    placeholderContract,
    placeholderDifferences,
    TARGET_VALUE_KIND,
} from '../src/shared/i18n-values.js'
import { flattenBundle } from './i18n-current.mjs'
import { writeLocaleAtomically } from './i18n-files.mjs'
import { createGitAdapter } from './i18n-git.mjs'
import {
    analyzeCommittedHistory,
    analyzeProspective,
    analyzeRepairableProspective,
    describeHistoryAvailability,
    I18N_LOCALE_DIR,
    snapshotFromBundles,
    workingTreeSnapshot,
} from './i18n-history.mjs'
import {
    applyBaseline,
    createHistoryState,
    entryId,
    PENDING_PROVENANCE,
} from './i18n-history-events.mjs'
import { inspectLocales } from './i18n-inspection.mjs'
import {
    applyReviewAction,
    buildReviewCandidates,
    prepareI18nReview,
    REVIEW_ACTION,
    reviewEditProblems,
    reviewLocaleSession,
    runI18nReview,
} from './i18n-review.mjs'

const LOCALE_DIR = 'i18n'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
}

function createRepository() {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-review-'))
    git(directory, ['init', '-q'])
    git(directory, ['config', 'user.email', 'review-test@example.invalid'])
    git(directory, ['config', 'user.name', 'Review Test'])
    git(directory, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(directory, LOCALE_DIR))
    return directory
}

function writeLocales(directory, locales) {
    for (const [id, bundle] of Object.entries(locales)) {
        const path = join(directory, LOCALE_DIR, `${id}.json`)
        if (bundle === null) {
            if (existsSync(path)) unlinkSync(path)
            continue
        }
        writeFileSync(path, `${JSON.stringify(bundle, null, 4)}\n`, 'utf8')
    }
}

function commitLocales(directory, locales, message) {
    writeLocales(directory, locales)
    git(directory, ['add', '-A'])
    git(directory, ['commit', '-q', '-m', message])
    return git(directory, ['rev-parse', 'HEAD'])
}

function readLocale(directory, id) {
    return JSON.parse(readFileSync(join(directory, LOCALE_DIR, `${id}.json`), 'utf8'))
}

function reviewOptions(directory, baseline, extra = {}) {
    return {
        cwd: directory,
        baseline,
        localeDir: LOCALE_DIR,
        i18nDir: join(directory, LOCALE_DIR),
        ...extra,
    }
}

async function withRepository(run) {
    const directory = createRepository()
    try {
        return await run(directory)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

function semanticHistory(revisions) {
    const baselineSnapshot = snapshotFromBundles('baseline', revisions[0])
    const state = applyBaseline(createHistoryState(), baselineSnapshot, 'baseline')
    let history = {
        baseline: 'baseline',
        revision: 'baseline',
        snapshot: baselineSnapshot,
        state,
        events: [],
        committedEvents: [],
    }
    const events = []
    for (let index = 1; index < revisions.length; index += 1) {
        const snapshot = snapshotFromBundles(`revision-${index}`, revisions[index])
        const next = analyzeRepairableProspective(history, snapshot)
        events.push(...next.prospectiveEvents)
        history = {
            ...next,
            revision: snapshot.revision,
            events: [...events],
            committedEvents: [...events],
            prospective: false,
        }
    }
    return history
}

function candidateFor(revisions, locale = 'de') {
    return buildReviewCandidates(semanticHistory(revisions), locale)[0]
}

function captureStream() {
    let output = ''
    return {
        stream: {
            write(value) {
                output += value
            },
        },
        value: () => output,
    }
}

function scriptedAnswers(values) {
    let index = 0
    return async () => {
        if (index >= values.length) throw new Error('Scripted review input exhausted')
        const answer = values[index]
        index += 1
        if (answer instanceof Error) throw answer
        return answer
    }
}

test('candidate context uses carried checkpoint English and current source and target', () => {
    const candidate = candidateFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'C' }, de: { value: '? X' } },
    ])
    assert.equal(candidate.key, 'value')
    assert.equal(candidate.lastAcceptedSourceText, 'A')
    assert.equal(candidate.currentSourceText, 'C')
    assert.equal(candidate.currentTargetText, 'X')
    assert.equal(candidate.placeholderCompatible, true)
    assert.equal(candidate.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
})

test('explicit requests and source-triggered Pending are both review candidates', () => {
    const explicit = candidateFor([
        { en: { value: 'B' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
    ])
    const sourceTriggered = candidateFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
    ])
    assert.equal(explicit.pendingProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
    assert.equal(explicit.lastAcceptedSourceText, 'B')
    assert.equal(explicit.currentSourceText, 'B')
    assert.equal(sourceTriggered.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
})

test('Pending edit context shows the current target rather than the checkpoint target', () => {
    const candidate = candidateFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'B' }, de: { value: '? Y' } },
    ])
    assert.equal(candidate.lastAcceptedTargetText, 'X')
    assert.equal(candidate.currentTargetText, 'Y')
})

test('Keep, Edit, and Skip have exact persisted-state semantics', () => {
    const candidate = candidateFor([
        { en: { value: 'A {name}' }, de: { value: 'X {name}' } },
        { en: { value: 'B {name}' }, de: { value: '? X {name}' } },
    ])
    assert.deepEqual(applyReviewAction(candidate, REVIEW_ACTION.KEEP), {
        changed: true,
        storedValue: 'X {name}',
    })
    assert.deepEqual(applyReviewAction(candidate, REVIEW_ACTION.EDIT, 'Y {name}'), {
        changed: true,
        storedValue: 'Y {name}',
    })
    assert.deepEqual(applyReviewAction(candidate, REVIEW_ACTION.SKIP), {
        changed: false,
        storedValue: '? X {name}',
    })
})

test('Keep and Edit enforce current placeholders and ordinary target syntax', () => {
    const candidate = candidateFor([
        { en: { value: 'A {name}' }, de: { value: 'X {name}' } },
        { en: { value: 'B {name}' }, de: { value: '? X {user}' } },
    ])
    assert.equal(candidate.placeholderCompatible, false)
    assert.throws(() => applyReviewAction(candidate, REVIEW_ACTION.KEEP), /Keep is unavailable/)
    assert.deepEqual(reviewEditProblems(candidate, 'Y {name}'), [])
    assert.match(reviewEditProblems(candidate, 'Y {user}').join('\n'), /Missing placeholder/)
    assert.match(reviewEditProblems(candidate, 'Y').join('\n'), /Missing placeholder/)
    assert.match(reviewEditProblems(candidate, '? Y {name}').join('\n'), /reserved/)
    assert.match(reviewEditProblems(candidate, '! Y {name}').join('\n'), /reserved/)
    assert.match(
        reviewEditProblems(candidate, `Y {name}${String.fromCodePoint(0)}`).join('\n'),
        /Unsafe Unicode/
    )

    const duplicateCandidate = candidateFor([
        { en: { value: 'A {name} {name}' }, de: { value: 'X {name} {name}' } },
        { en: { value: 'B {name} {name}' }, de: { value: '? X {name} {name}' } },
    ])
    assert.match(
        reviewEditProblems(duplicateCandidate, 'Y {name}').join('\n'),
        /Missing placeholder/
    )
})

test('an uncommitted explicit request is discovered from the working tree', async () => {
    await withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        writeLocales(directory, { de: { value: '? X' } })
        const review = prepareI18nReview({
            ...reviewOptions(directory, baseline),
            localeId: 'de',
        })
        assert.equal(review.candidates.length, 1)
        assert.equal(review.candidates[0].pendingProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
    })
})

test('working-tree Keep removes the Pending entry from the review queue', async () => {
    await withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        writeLocales(directory, { de: { value: 'X' } })

        const review = prepareI18nReview({
            ...reviewOptions(directory, baseline),
            localeId: 'de',
        })
        assert.deepEqual(review.candidates, [])
    })
})

test('working-tree Pending edit keeps lineage and exposes the current target', async () => {
    await withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        writeLocales(directory, { de: { value: '? Y' } })

        const review = prepareI18nReview({
            ...reviewOptions(directory, baseline),
            localeId: 'de',
        })
        assert.equal(review.candidates.length, 1)
        assert.equal(review.candidates[0].lastAcceptedSourceText, 'A')
        assert.equal(review.candidates[0].lastAcceptedTargetText, 'X')
        assert.equal(review.candidates[0].currentTargetText, 'Y')
    })
})

test('singular and plural Pending members remain independent candidates in source order', () => {
    const history = semanticHistory([
        {
            en: { countSingle: 'A', count: 'B' },
            de: { countSingle: 'X', count: 'Y' },
        },
        {
            en: { countSingle: 'AA', count: 'BB' },
            de: { countSingle: '? X', count: '? Y' },
        },
    ])
    assert.deepEqual(
        buildReviewCandidates(history, 'de').map(({ key }) => key),
        ['countSingle', 'count']
    )

    const singularOnly = semanticHistory([
        {
            en: { countSingle: 'A', count: 'B' },
            de: { countSingle: 'X', count: 'Y' },
        },
        {
            en: { countSingle: 'AA', count: 'B' },
            de: { countSingle: '? X', count: 'Y' },
        },
    ])
    assert.deepEqual(
        buildReviewCandidates(singularOnly, 'de').map(({ key }) => key),
        ['countSingle']
    )

    const pluralOnly = semanticHistory([
        {
            en: { countSingle: 'A', count: 'B' },
            de: { countSingle: 'X', count: 'Y' },
        },
        {
            en: { countSingle: 'A', count: 'BB' },
            de: { countSingle: 'X', count: '? Y' },
        },
    ])
    assert.deepEqual(
        buildReviewCandidates(pluralOnly, 'de').map(({ key }) => key),
        ['count']
    )
})

test('multi-entry session saves Keep and Edit incrementally while Skip remains Pending', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { first: 'A', second: 'B {name}', third: 'C' },
                de: { first: 'X', second: 'Y {name}', third: 'Z' },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: { first: 'AA', second: 'BB {name}', third: 'CC' },
                de: { first: '? X', second: '? Y {name}', third: '? Z' },
            },
            'pending'
        )
        let writes = 0
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers(['k', 'e', 'Neu {name}', 's']),
            stdout: captureStream().stream,
            stderr: captureStream().stream,
            write(path, bundle) {
                writes += 1
                return writeLocaleAtomically(path, bundle)
            },
        })
        assert.equal(status, 0)
        assert.equal(writes, 2)
        assert.deepEqual(readLocale(directory, 'de'), {
            first: 'X',
            second: 'Neu {name}',
            third: '? Z',
        })
    })
})

test('all-Skip session preserves exact bytes and performs no writes', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { first: 'A', second: 'B', third: 'C' },
                de: { first: 'X', second: 'Y', third: 'Z' },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: { first: 'AA', second: 'BB', third: 'CC' },
                de: { first: '? X', second: '? Y', third: '? Z' },
            },
            'pending'
        )
        const localePath = join(directory, LOCALE_DIR, 'de.json')
        const before = readFileSync(localePath)
        const indexBefore = git(directory, ['write-tree'])
        let writes = 0
        assert.equal(
            await runI18nReview(['de'], {
                ...reviewOptions(directory, baseline),
                ask: scriptedAnswers(['s', 's', 's']),
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                write() {
                    writes += 1
                },
            }),
            0
        )
        assert.equal(writes, 0)
        assert.deepEqual(readFileSync(localePath), before)
        assert.equal(git(directory, ['write-tree']), indexBefore)
    })
})

test('incompatible Pending disables Keep and Edit can repair placeholders', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A {name}' }, de: { value: 'X {name}' } },
            'baseline'
        )
        commitLocales(
            directory,
            { en: { value: 'B {name}' }, de: { value: '? X {user}' } },
            'pending'
        )
        const stdout = captureStream()
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers(['k', 'e', 'Y {name}']),
            stdout: stdout.stream,
            stderr: captureStream().stream,
        })
        assert.equal(status, 0)
        assert.equal(readLocale(directory, 'de').value, 'Y {name}')
        assert.match(stdout.value(), /incompatible \(runtime uses English\)/)
        assert.match(stdout.value(), /Keep is unavailable/)
    })
})

test('invalid Edit input is not written and Enter preserves Pending', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        let writes = 0
        const stdout = captureStream()
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers(['e', '? Invalid', '']),
            stdout: stdout.stream,
            stderr: captureStream().stream,
            write() {
                writes += 1
            },
        })
        assert.equal(status, 0)
        assert.equal(writes, 0)
        assert.equal(readLocale(directory, 'de').value, '? X')
        assert.match(stdout.value(), /Invalid target/)
    })
})

test('review preserves unrelated repairable sync debt exactly', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: {
                    review: 'A',
                    missing: 'Missing',
                    stale: 'Old scaffold',
                    drift: 'Old accepted source',
                    obsolete: 'Obsolete source',
                },
                de: {
                    review: 'X',
                    stale: '! Old scaffold',
                    drift: 'Accepted target',
                    obsolete: '! Obsolete source',
                },
            },
            'baseline'
        )
        writeLocales(directory, {
            en: {
                review: 'B',
                missing: 'Missing',
                stale: 'New scaffold',
                drift: 'New accepted source',
            },
            de: {
                review: '? X',
                stale: '! Old scaffold',
                drift: 'Accepted target',
                obsolete: '! Obsolete source',
            },
        })

        assert.equal(
            await runI18nReview(['de'], {
                ...reviewOptions(directory, baseline),
                ask: scriptedAnswers(['k']),
                stdout: captureStream().stream,
                stderr: captureStream().stream,
            }),
            0
        )
        assert.deepEqual(readLocale(directory, 'de'), {
            review: 'X',
            stale: '! Old scaffold',
            drift: 'Accepted target',
            obsolete: '! Obsolete source',
        })
    })
})

test('obsolete Accepted and Pending targets still block review before prompting', async () => {
    for (const obsoleteTarget of ['Real target', '? Real target']) {
        await withRepository(async (directory) => {
            const baseline = commitLocales(
                directory,
                {
                    en: { review: 'A', obsolete: 'Old source' },
                    de: { review: 'X', obsolete: 'Real target' },
                },
                'baseline'
            )
            writeLocales(directory, {
                en: { review: 'B' },
                de: { review: '? X', obsolete: obsoleteTarget },
            })
            let prompts = 0
            let writes = 0
            const status = await runI18nReview(['de'], {
                ...reviewOptions(directory, baseline),
                ask: async () => {
                    prompts += 1
                    return 'k'
                },
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                write() {
                    writes += 1
                },
            })
            assert.equal(status, 1)
            assert.equal(prompts, 0)
            assert.equal(writes, 0)
        })
    }
})

test('locale with no Pending values exits successfully without prompting or writing', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        let prompts = 0
        let writes = 0
        const stdout = captureStream()
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: async () => {
                prompts += 1
                return 's'
            },
            stdout: stdout.stream,
            stderr: captureStream().stream,
            write() {
                writes += 1
            },
        })
        assert.equal(status, 0)
        assert.equal(prompts, 0)
        assert.equal(writes, 0)
        assert.match(stdout.value(), /no translations need review/)
    })
})

test('missing history and orphan Pending fail before prompting or writing', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        let prompts = 0
        let writes = 0
        const stderr = captureStream()
        const options = {
            ...reviewOptions(directory, '0000000000000000000000000000000000000000'),
            ask: async () => {
                prompts += 1
                return 's'
            },
            stdout: captureStream().stream,
            stderr: stderr.stream,
            write() {
                writes += 1
            },
        }
        assert.equal(await runI18nReview(['de'], options), 1)
        assert.match(stderr.value(), /Full i18n history through the audited baseline is required/)

        commitLocales(directory, { en: { value: 'A' }, de: {} }, 'withdraw')
        writeLocales(directory, { de: { value: '? X' } })
        assert.equal(await runI18nReview(['de'], { ...options, baseline }), 1)
        assert.equal(prompts, 0)
        assert.equal(writes, 0)
    })
})

test('shallow history refuses review before prompting or writing', async () => {
    await withRepository(async (sourceDirectory) => {
        const baseline = commitLocales(
            sourceDirectory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(sourceDirectory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')

        const cloneParent = mkdtempSync(join(tmpdir(), 'modrex-i18n-review-shallow-'))
        const clone = join(cloneParent, 'clone')
        try {
            execFileSync(
                'git',
                ['clone', '-q', '--depth', '1', pathToFileURL(sourceDirectory).href, clone],
                { stdio: ['ignore', 'pipe', 'pipe'] }
            )
            let prompts = 0
            let writes = 0
            const stderr = captureStream()
            const status = await runI18nReview(['de'], {
                ...reviewOptions(clone, baseline),
                ask: async () => {
                    prompts += 1
                    return 'k'
                },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                write() {
                    writes += 1
                },
            })
            assert.equal(status, 1)
            assert.equal(prompts, 0)
            assert.equal(writes, 0)
            assert.match(stderr.value(), /shallow checkout|Full i18n history/)
            assert.equal(readLocale(clone, 'de').value, '? X')
        } finally {
            rmSync(cloneParent, { recursive: true, force: true })
        }
    })
})

test('malformed current data and accepted placeholder mismatch fail before prompting', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { review: 'A', invalid: 'Value {name}' },
                de: { review: 'X', invalid: 'Wert {name}' },
            },
            'baseline'
        )
        let prompts = 0
        let writes = 0
        const options = {
            ...reviewOptions(directory, baseline),
            ask: async () => {
                prompts += 1
                return 's'
            },
            stdout: captureStream().stream,
            stderr: captureStream().stream,
            write() {
                writes += 1
            },
        }

        writeFileSync(join(directory, LOCALE_DIR, 'de.json'), '{ invalid', 'utf8')
        assert.equal(await runI18nReview(['de'], options), 1)

        writeLocales(directory, {
            en: { review: 'B', invalid: 'Value {name}' },
            de: { review: '? X', invalid: 'Wert {user}' },
        })
        assert.equal(await runI18nReview(['de'], options), 1)
        assert.equal(prompts, 0)
        assert.equal(writes, 0)
    })
})

test('successful progress survives a later write failure', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { first: 'A', second: 'B' }, de: { first: 'X', second: 'Y' } },
            'baseline'
        )
        commitLocales(
            directory,
            { en: { first: 'AA', second: 'BB' }, de: { first: '? X', second: '? Y' } },
            'pending'
        )
        let writes = 0
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers(['k', 'k']),
            stdout: captureStream().stream,
            stderr: captureStream().stream,
            write(path, bundle) {
                writes += 1
                if (writes === 2) throw new Error('injected review write failure')
                return writeLocaleAtomically(path, bundle)
            },
        })
        assert.equal(status, 1)
        assert.deepEqual(readLocale(directory, 'de'), { first: 'X', second: '? Y' })
    })
})

test('EOF after a successful decision preserves prior progress', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { first: 'A', second: 'B' }, de: { first: 'X', second: 'Y' } },
            'baseline'
        )
        commitLocales(
            directory,
            { en: { first: 'AA', second: 'BB' }, de: { first: '? X', second: '? Y' } },
            'pending'
        )
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers(['k', new Error('EOF')]),
            stdout: captureStream().stream,
            stderr: captureStream().stream,
        })
        assert.equal(status, 1)
        assert.deepEqual(readLocale(directory, 'de'), { first: 'X', second: '? Y' })
    })
})

test('EOF before the first action leaves Pending state and index unchanged', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        const indexBefore = git(directory, ['write-tree'])
        let writes = 0
        const status = await runI18nReview(['de'], {
            ...reviewOptions(directory, baseline),
            ask: scriptedAnswers([new Error('EOF')]),
            stdout: captureStream().stream,
            stderr: captureStream().stream,
            write() {
                writes += 1
            },
        })
        assert.equal(status, 1)
        assert.equal(writes, 0)
        assert.equal(readLocale(directory, 'de').value, '? X')
        assert.equal(git(directory, ['write-tree']), indexBefore)
    })
})

test('review preserves an existing staged change and leaves commit graph unchanged', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        writeFileSync(join(directory, 'staged.txt'), 'staged\n', 'utf8')
        git(directory, ['add', 'staged.txt'])
        const indexBefore = git(directory, ['write-tree'])
        const headBefore = git(directory, ['rev-parse', 'HEAD'])
        assert.equal(
            await runI18nReview(['de'], {
                ...reviewOptions(directory, baseline),
                ask: scriptedAnswers(['k']),
                stdout: captureStream().stream,
                stderr: captureStream().stream,
            }),
            0
        )
        assert.equal(git(directory, ['write-tree']), indexBefore)
        assert.equal(git(directory, ['rev-parse', 'HEAD']), headBefore)
    })
})

test('invalid review usage exits 2 without reading history', async () => {
    const stderr = captureStream()
    for (const args of [[], ['de', 'ru'], ['en'], ['not_a_locale'], ['fr']]) {
        assert.equal(await runI18nReview(args, { stderr: stderr.stream }), 2)
    }
    assert.match(
        stderr.value(),
        /Usage: pnpm i18n:review|English source|valid locale code|does not exist/
    )
})

const realHistory = describeHistoryAvailability({ cwd: REPOSITORY_ROOT })
const localeWorktreeStatus = git(REPOSITORY_ROOT, ['status', '--porcelain', '--', I18N_LOCALE_DIR])
let unavailableRealReviewReason = false
if (!realHistory.available) unavailableRealReviewReason = 'authoritative history is unavailable'
if (realHistory.available && localeWorktreeStatus) {
    unavailableRealReviewReason = 'real locale files have uncommitted changes'
}

test(
    'real review candidates expose authoritative context without writing files',
    { skip: unavailableRealReviewReason },
    () => {
        const i18nDir = resolve(REPOSITORY_ROOT, I18N_LOCALE_DIR)
        const inspection = inspectLocales(i18nDir)
        const localeBytesBefore = new Map(
            ['en', ...inspection.locales.map(({ id }) => id)].map((id) => [
                id,
                readFileSync(resolve(i18nDir, `${id}.json`)),
            ])
        )
        const indexBefore = git(REPOSITORY_ROOT, ['write-tree'])
        const committed = analyzeCommittedHistory({ cwd: REPOSITORY_ROOT })
        const history = analyzeProspective(
            committed,
            workingTreeSnapshot(REPOSITORY_ROOT, I18N_LOCALE_DIR)
        )
        const historyGit = createGitAdapter({ cwd: REPOSITORY_ROOT })
        for (const locale of inspection.locales) {
            const candidates = buildReviewCandidates(history, locale.id)
            assert.deepEqual(
                candidates.map(({ key }) => key),
                locale.pendingKeys
            )
            for (const candidate of candidates) {
                const persisted = locale.targetValues[candidate.key]
                assert.equal(persisted.kind, TARGET_VALUE_KIND.PENDING)
                assert.equal(candidate.locale, locale.id)
                assert.equal(candidate.currentTargetText, persisted.targetText)
                assert.equal(candidate.currentSourceText, inspection.sourceStrings[candidate.key])

                const stateEntry = history.state.entries.get(entryId(locale.id, candidate.key))
                assert.ok(stateEntry?.pending)
                const checkpoint = stateEntry.pending.lineageCheckpoint
                assert.ok(checkpoint)
                assert.equal(candidate.checkpointRevision, checkpoint.revision)
                assert.equal(
                    historyGit.resolveRevision(candidate.checkpointRevision),
                    candidate.checkpointRevision
                )

                const checkpointPaths = historyGit.treeBlobs(
                    candidate.checkpointRevision,
                    I18N_LOCALE_DIR
                )
                const sourcePath = `${I18N_LOCALE_DIR}/en.json`
                const targetPath = `${I18N_LOCALE_DIR}/${locale.id}.json`
                const sourceBlob = checkpointPaths.get(sourcePath)
                const targetBlob = checkpointPaths.get(targetPath)
                assert.ok(sourceBlob)
                assert.ok(targetBlob)
                const checkpointBlobs = historyGit.readBlobs([sourceBlob, targetBlob])
                const sourceErrors = []
                const targetErrors = []
                const checkpointSource = flattenBundle(
                    JSON.parse(checkpointBlobs.get(sourceBlob)),
                    'en',
                    sourceErrors
                )[candidate.key]
                const checkpointTargetStored = flattenBundle(
                    JSON.parse(checkpointBlobs.get(targetBlob)),
                    locale.id,
                    targetErrors
                )[candidate.key]
                assert.deepEqual(sourceErrors, [])
                assert.deepEqual(targetErrors, [])
                const checkpointTarget = parseTargetValue(checkpointTargetStored)
                assert.equal(checkpointTarget.kind, TARGET_VALUE_KIND.ACCEPTED)
                assert.equal(checkpoint.rawSourceText, checkpointSource)
                assert.equal(checkpoint.rawTargetText, checkpointTarget.targetText)
                assert.equal(candidate.lastAcceptedSourceText, checkpointSource)
                assert.equal(candidate.lastAcceptedTargetText, checkpointTarget.targetText)
                assert.equal(candidate.pendingProvenance, stateEntry.pending.provenance)

                const placeholderDifference = placeholderDifferences(
                    placeholderContract(inspection.sourceStrings[candidate.key]),
                    placeholderContract(persisted.targetText)
                )
                const placeholderCompatible =
                    placeholderDifference.missing.length === 0 &&
                    placeholderDifference.unexpected.length === 0
                assert.equal(candidate.placeholderCompatible, placeholderCompatible)
            }
        }
        for (const [id, before] of localeBytesBefore) {
            assert.deepEqual(readFileSync(resolve(i18nDir, `${id}.json`)), before)
        }
        assert.equal(git(REPOSITORY_ROOT, ['write-tree']), indexBefore)
    }
)

test('prepare returns the same deterministic candidate order without mutating files', async () => {
    await withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { first: 'A', second: 'B' }, de: { first: 'X', second: 'Y' } },
            'baseline'
        )
        commitLocales(
            directory,
            { en: { first: 'AA', second: 'BB' }, de: { first: '? X', second: '? Y' } },
            'pending'
        )
        const before = readFileSync(join(directory, LOCALE_DIR, 'de.json'), 'utf8')
        const review = prepareI18nReview({
            ...reviewOptions(directory, baseline),
            localeId: 'de',
        })
        assert.deepEqual(
            review.candidates.map(({ key }) => key),
            ['first', 'second']
        )
        assert.equal(readFileSync(join(directory, LOCALE_DIR, 'de.json'), 'utf8'), before)
    })
})

test('session core accepts an injected writer and scripted actions without stdin', async () => {
    await withRepository(async (directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        commitLocales(directory, { en: { value: 'B' }, de: { value: '? X' } }, 'pending')
        const review = prepareI18nReview({
            ...reviewOptions(directory, baseline),
            localeId: 'de',
        })
        const stdout = captureStream()
        const counts = await reviewLocaleSession({
            review,
            ask: scriptedAnswers(['s']),
            stdout: stdout.stream,
            write() {
                throw new Error('Skip must not write')
            },
        })
        assert.deepEqual(counts, { edited: 0, kept: 0, skipped: 1 })
        assert.equal(readLocale(directory, 'de').value, '? X')
        assert.match(stdout.value(), /English at last accepted checkpoint:\n  A/)
        assert.match(stdout.value(), /Current English:\n  B/)
        assert.match(stdout.value(), /Current target:\n  X/)
        assert.match(stdout.value(), /Placeholder status: compatible/)
        assert.match(
            stdout.value(),
            /record your decision; they do not prove linguistic correctness/
        )
    })
})

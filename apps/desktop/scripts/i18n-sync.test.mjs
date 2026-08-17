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
import { fileURLToPath } from 'node:url'
import { PENDING_PREFIX } from '../src/shared/i18n-values.js'
import { writeSerializedFileAtomically } from './i18n-files.mjs'
import {
    analyzeRepairableProspective,
    describeHistoryAvailability,
    I18N_LOCALE_DIR,
    snapshotFromBundles,
    summarizeHistory,
} from './i18n-history.mjs'
import { applyBaseline, createHistoryState, PENDING_PROVENANCE } from './i18n-history-events.mjs'
import {
    applySyncWrites,
    formatSyncSummary,
    I18nSyncPlanError,
    planI18nSync,
    runI18nSync,
    SYNC_OPERATION,
    synchronizeI18n,
} from './i18n-sync.mjs'

const LOCALE_DIR = 'i18n'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

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

function planFor(revisions) {
    const history = semanticHistory(revisions)
    return planI18nSync({ history, sourceBundle: revisions.at(-1).en })
}

function localePlan(plan, id = 'de') {
    return plan.locales.find((locale) => locale.id === id)
}

function operationKinds(plan, id = 'de') {
    return localePlan(plan, id).operations.map(({ kind }) => kind)
}

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
}

function createRepository() {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-sync-'))
    git(directory, ['init', '-q'])
    git(directory, ['config', 'user.email', 'sync-test@example.invalid'])
    git(directory, ['config', 'user.name', 'Sync Test'])
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

function syncOptions(directory, baseline, extra = {}) {
    return {
        cwd: directory,
        baseline,
        localeDir: LOCALE_DIR,
        i18nDir: join(directory, LOCALE_DIR),
        ...extra,
    }
}

function withRepository(run) {
    const directory = createRepository()
    try {
        return run(directory)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

test('planner scaffolds absent keys and refreshes stale scaffolds', () => {
    const plan = planFor([
        { en: { current: 'Old', added: 'Added' }, de: { current: '! Old' } },
        { en: { current: 'New', added: 'Added' }, de: { current: '! Old' } },
    ])
    assert.deepEqual(localePlan(plan).bundle, { current: '! New', added: '! Added' })
    assert.deepEqual(operationKinds(plan), [
        SYNC_OPERATION.SCAFFOLD_REFRESHED,
        SYNC_OPERATION.SCAFFOLD_ADDED,
    ])
})

test('planner marks accepted text after every non-NFC-equivalent source change', () => {
    for (const changed of ['A.', ' a', 'a', 'A...']) {
        const plan = planFor([
            { en: { value: 'A' }, de: { value: 'X' } },
            { en: { value: changed }, de: { value: 'X' } },
        ])
        assert.equal(localePlan(plan).bundle.value, '? X')
        assert.deepEqual(operationKinds(plan), [SYNC_OPERATION.REVIEW_REQUESTED])
    }
})

test('NFC-equivalent source spelling does not request review', () => {
    const plan = planFor([
        { en: { value: 'Cafe\u0301' }, de: { value: 'Grün' } },
        { en: { value: 'Café' }, de: { value: 'Grün' } },
    ])
    assert.equal(localePlan(plan).bundle.value, 'Grün')
    assert.deepEqual(operationKinds(plan), [])
})

test('source return clears only source-triggered Pending', () => {
    const plan = planFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'A' }, de: { value: '? X' } },
    ])
    assert.equal(localePlan(plan).bundle.value, 'X')
    assert.deepEqual(operationKinds(plan), [SYNC_OPERATION.SOURCE_RETURN_CLEARED])
})

test('explicit review remains Pending even when its accepted pair is current', () => {
    const plan = planFor([
        { en: { value: 'B' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
    ])
    assert.equal(localePlan(plan).bundle.value, '? X')
    assert.deepEqual(operationKinds(plan), [])
})

test('explicit review remains Pending through source changes and return', () => {
    const plan = planFor([
        { en: { value: 'B' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'C' }, de: { value: '? X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
    ])
    assert.equal(localePlan(plan).bundle.value, '? X')
})

test('sync preserves explicit requests across multiple locales despite accepted pair matches', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { value: 'B' },
                de: { value: 'X' },
                ru: { value: 'Y' },
                uk: { value: 'Z' },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: { value: 'B' },
                de: { value: '? X' },
                ru: { value: '? Y' },
                uk: { value: 'Z' },
            },
            'request review'
        )

        const result = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(result.written, [])
        assert.deepEqual(
            result.plan.locales.map(({ id, operations }) => [id, operations]),
            [
                ['de', []],
                ['ru', []],
                ['uk', []],
            ]
        )

        const summary = summarizeHistory(result.finalHistory)
        for (const [localeId, targetText] of [
            ['de', 'X'],
            ['ru', 'Y'],
        ]) {
            const entry = summary.locales.get(localeId).entries.get('value')
            assert.equal(entry.state, 'pending')
            assert.equal(entry.canonicalTarget, targetText)
            assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
            assert.equal(entry.acceptedPairSeen, true)
            assert.equal(localePlan(result.plan, localeId).bundle.value, `? ${targetText}`)
        }
    })
})

test('Pending edits retain their text, marker, and carried provenance', () => {
    const history = semanticHistory([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'C' }, de: { value: '? Y' } },
    ])
    const plan = planI18nSync({ history, sourceBundle: { value: 'C' } })
    assert.equal(localePlan(plan).bundle.value, '? Y')
    assert.equal(
        summarizeHistory(history).locales.get('de').entries.get('value').pendingProvenance,
        PENDING_PROVENANCE.SOURCE_CHANGE
    )
})

test('prospective Keep and accepted edits are preserved', () => {
    const kept = planFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'B' }, de: { value: 'X' } },
    ])
    assert.equal(localePlan(kept).bundle.value, 'X')

    const edited = planFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: 'Y' } },
    ])
    assert.equal(localePlan(edited).bundle.value, 'Y')
})

test('same-transition source and target edit accepts the resulting pair', () => {
    const plan = planFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: 'Y' } },
    ])
    assert.equal(localePlan(plan).bundle.value, 'Y')
    assert.deepEqual(operationKinds(plan), [])
})

test('further source changes keep one Pending marker', () => {
    const plan = planFor([
        { en: { value: 'A' }, de: { value: 'X' } },
        { en: { value: 'B' }, de: { value: '? X' } },
        { en: { value: 'C' }, de: { value: '? X' } },
    ])
    assert.equal(localePlan(plan).bundle.value, '? X')
})

test('obsolete scaffolds are removed and target content blocks', () => {
    const scaffoldPlan = planFor([
        { en: { old: 'Old', kept: 'Kept' }, de: { old: '! Old', kept: 'Z' } },
        { en: { kept: 'Kept' }, de: { old: '! Old', kept: 'Z' } },
    ])
    assert.deepEqual(localePlan(scaffoldPlan).bundle, { kept: 'Z' })
    assert.deepEqual(operationKinds(scaffoldPlan), [SYNC_OPERATION.SCAFFOLD_REMOVED])

    for (const target of ['X', '? X']) {
        assert.throws(
            () =>
                planFor([
                    { en: { old: 'Old', kept: 'Kept' }, de: { old: 'X', kept: 'Z' } },
                    { en: { kept: 'Kept' }, de: { old: target, kept: 'Z' } },
                ]),
            I18nSyncPlanError
        )
    }
})

test('rename is not inferred from identical English text', () => {
    assert.throws(
        () =>
            planFor([
                { en: { old: 'Same' }, de: { old: 'X' } },
                { en: { renamed: 'Same' }, de: { old: 'X' } },
            ]),
        I18nSyncPlanError
    )
})

test('English nesting and order determine serialized target structure', () => {
    const plan = planFor([
        { en: { group: { first: 'A', second: 'B' } }, de: { group: { first: 'X' } } },
    ])
    assert.deepEqual(localePlan(plan).bundle, {
        group: { first: 'X', second: '! B' },
    })
})

test('marker insertion and removal preserve target payload bytes', () => {
    const target = '  Gru\u0308n\n{name}  '
    const inserted = planFor([
        { en: { value: 'A {name}' }, de: { value: target } },
        { en: { value: 'B {name}' }, de: { value: target } },
    ])
    assert.equal(localePlan(inserted).bundle.value.slice(PENDING_PREFIX.length), target)

    const cleared = planFor([
        { en: { value: 'A {name}' }, de: { value: target } },
        { en: { value: 'B {name}' }, de: { value: `${PENDING_PREFIX}${target}` } },
        { en: { value: 'A {name}' }, de: { value: `${PENDING_PREFIX}${target}` } },
    ])
    assert.equal(localePlan(cleared).bundle.value, target)
})

test('one sync invocation processes every discovered target locale', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { a: 'A' }, de: { a: 'X' }, ru: { a: 'Y' } },
            'baseline'
        )
        writeLocales(directory, { en: { a: 'A', b: 'B' } })
        const result = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(result.written, ['de', 'ru'])
        assert.equal(readLocale(directory, 'de').b, '! B')
        assert.equal(readLocale(directory, 'ru').b, '! B')
    })
})

test('source change inserts Review and allows a resulting Pending placeholder mismatch', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { a: 'A {old}' }, de: { a: 'X {old}' } },
            'baseline'
        )
        writeLocales(directory, { en: { a: 'B {new}' } })
        synchronizeI18n(syncOptions(directory, baseline))
        assert.equal(readLocale(directory, 'de').a, '? X {old}')
    })
})

test('prospective Keep, Edit, and Pending edit survive synchronization', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { keep: 'A', edit: 'A', pending: 'A' },
                de: { keep: 'K', edit: 'E', pending: 'P' },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: { keep: 'B', edit: 'B', pending: 'B' },
                de: { keep: '? K', edit: '? E', pending: '? P' },
            },
            'pending'
        )
        writeLocales(directory, { de: { keep: 'K', edit: 'Edited', pending: '? Pending edit' } })
        const result = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(result.written, [])
        assert.deepEqual(readLocale(directory, 'de'), {
            keep: 'K',
            edit: 'Edited',
            pending: '? Pending edit',
        })
    })
})

test('a working-tree source and target edit remains Accepted', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        writeLocales(directory, { en: { value: 'B' }, de: { value: 'Y' } })
        const result = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(result.written, [])
        assert.equal(readLocale(directory, 'de').value, 'Y')
    })
})

test('an accepted placeholder mismatch against its current checkpoint blocks before writes', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A {name}' }, de: { value: 'X {name}' } },
            'baseline'
        )
        writeLocales(directory, { de: { value: 'Y {other}' } })
        let writes = 0
        assert.throws(() =>
            synchronizeI18n(
                syncOptions(directory, baseline, {
                    write: () => {
                        writes += 1
                    },
                })
            )
        )
        assert.equal(writes, 0)
    })
})

test('source return clears eligible Pending but preserves explicit review', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { returned: 'A', explicit: 'B' }, de: { returned: 'X', explicit: 'Y' } },
            'baseline'
        )
        commitLocales(
            directory,
            { en: { returned: 'C', explicit: 'B' }, de: { returned: '? X', explicit: '? Y' } },
            'pending'
        )
        writeLocales(directory, { en: { returned: 'A', explicit: 'B' } })
        synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(readLocale(directory, 'de'), { returned: 'X', explicit: '? Y' })
    })
})

test('sync repairs scaffolds, ordering, and obsolete scaffolds idempotently', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { first: 'A', second: 'B' }, de: { first: '! A', second: 'X' } },
            'baseline'
        )
        writeLocales(directory, {
            en: { first: 'New', second: 'B', third: 'C' },
            de: { obsolete: '! Removed', second: 'X', first: '! A' },
        })
        const first = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(first.written, ['de'])
        assert.deepEqual(readLocale(directory, 'de'), {
            first: '! New',
            second: 'X',
            third: '! C',
        })
        const before = readFileSync(join(directory, LOCALE_DIR, 'de.json'), 'utf8')
        const second = synchronizeI18n(syncOptions(directory, baseline))
        assert.deepEqual(second.written, [])
        assert.equal(readFileSync(join(directory, LOCALE_DIR, 'de.json'), 'utf8'), before)
    })
})

test('obsolete target content blocks every locale before writes', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { obsolete: 'Old', current: 'A' },
                de: { obsolete: 'X', current: '! A' },
                ru: { obsolete: '! Old', current: '! A' },
            },
            'baseline'
        )
        writeLocales(directory, {
            en: { current: 'B', added: 'C' },
            ru: { obsolete: '! Old', current: '! A' },
        })
        const before = readFileSync(join(directory, LOCALE_DIR, 'ru.json'), 'utf8')
        let diagnostic = ''
        const status = runI18nSync([], {
            ...syncOptions(directory, baseline),
            stdout: { write() {} },
            stderr: {
                write(value) {
                    diagnostic += value
                },
            },
        })
        assert.equal(status, 1)
        assert.match(diagnostic, /Remove or migrate each target value explicitly/)
        assert.equal(readFileSync(join(directory, LOCALE_DIR, 'ru.json'), 'utf8'), before)
    })
})

test('obsolete Pending content blocks every locale before writes', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: { obsolete: 'Old', current: 'A' },
                de: { obsolete: 'X', current: 'D' },
                ru: { obsolete: '! Old', current: '! A' },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: { obsolete: 'Old', current: 'A' },
                de: { obsolete: '? X', current: 'D' },
                ru: { obsolete: '! Old', current: '! A' },
            },
            'request review'
        )
        writeLocales(directory, {
            en: { current: 'B', added: 'C' },
            ru: { obsolete: '! Old', current: '! A' },
        })
        const before = readFileSync(join(directory, LOCALE_DIR, 'ru.json'), 'utf8')
        let diagnostic = ''
        const status = runI18nSync([], {
            ...syncOptions(directory, baseline),
            stdout: { write() {} },
            stderr: {
                write(value) {
                    diagnostic += value
                },
            },
        })
        assert.equal(status, 1)
        assert.match(diagnostic, /Remove or migrate each target value explicitly/)
        assert.equal(readFileSync(join(directory, LOCALE_DIR, 'ru.json'), 'utf8'), before)
    })
})

test('missing history and malformed working data cause zero writes', () => {
    withRepository((directory) => {
        const baseline = commitLocales(directory, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        let writes = 0
        assert.throws(() =>
            synchronizeI18n(
                syncOptions(directory, '0000000000000000000000000000000000000000', {
                    write: () => {
                        writes += 1
                    },
                })
            )
        )
        assert.equal(writes, 0)

        writeLocales(directory, { de: { a: '? ' } })
        assert.throws(() =>
            synchronizeI18n(
                syncOptions(directory, baseline, {
                    write: () => {
                        writes += 1
                    },
                })
            )
        )
        assert.equal(writes, 0)
    })
})

test('sync leaves the index and commit graph unchanged', () => {
    withRepository((directory) => {
        const baseline = commitLocales(directory, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(directory, { en: { a: 'A', b: 'B' } })
        const head = git(directory, ['rev-parse', 'HEAD'])
        const index = git(directory, ['diff', '--cached', '--binary'])
        synchronizeI18n(syncOptions(directory, baseline))
        assert.equal(git(directory, ['rev-parse', 'HEAD']), head)
        assert.equal(git(directory, ['diff', '--cached', '--binary']), index)
    })
})

test('atomic writer skips unchanged bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-writer-'))
    try {
        const path = join(directory, 'de.json')
        writeFileSync(path, '{}\n')
        assert.equal(writeSerializedFileAtomically(path, '{}\n'), false)
        assert.equal(writeSerializedFileAtomically(path, '{\n    "a": "A"\n}\n'), true)
        assert.equal(readFileSync(path, 'utf8'), '{\n    "a": "A"\n}\n')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('writer failure leaves prior files replaced and later files untouched, then rerun converges', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-writer-'))
    try {
        const writes = ['de', 'ru', 'uk'].map((id) => {
            const path = join(directory, `${id}.json`)
            writeFileSync(path, 'old\n')
            return { id, path, serialized: `${id}\n`, changed: true }
        })
        let calls = 0
        assert.throws(() =>
            applySyncWrites(writes, (path, serialized) => {
                calls += 1
                if (calls === 2) throw new Error('injected write failure')
                return writeSerializedFileAtomically(path, serialized)
            })
        )
        assert.equal(readFileSync(writes[0].path, 'utf8'), 'de\n')
        assert.equal(readFileSync(writes[1].path, 'utf8'), 'old\n')
        assert.equal(readFileSync(writes[2].path, 'utf8'), 'old\n')
        applySyncWrites(writes)
        for (const item of writes) assert.equal(readFileSync(item.path, 'utf8'), item.serialized)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('summary reports every applied workflow operation with exact counts', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            {
                en: {
                    refresh: 'Old',
                    obsolete: 'Gone',
                    reviewOne: 'A',
                    reviewTwo: 'A',
                    reviewThree: 'A',
                    returned: 'A',
                },
                de: {
                    refresh: '! Old',
                    obsolete: '! Gone',
                    reviewOne: 'X',
                    reviewTwo: 'Y',
                    reviewThree: 'Z',
                    returned: 'R',
                },
            },
            'baseline'
        )
        commitLocales(
            directory,
            {
                en: {
                    refresh: 'Old',
                    obsolete: 'Gone',
                    reviewOne: 'A',
                    reviewTwo: 'A',
                    reviewThree: 'A',
                    returned: 'B',
                },
                de: {
                    refresh: '! Old',
                    obsolete: '! Gone',
                    reviewOne: 'X',
                    reviewTwo: 'Y',
                    reviewThree: 'Z',
                    returned: '? R',
                },
            },
            'pending'
        )
        writeLocales(directory, {
            en: {
                addedOne: '? One',
                addedTwo: 'Two',
                refresh: 'New',
                reviewOne: 'B',
                reviewTwo: 'B',
                reviewThree: 'B',
                returned: 'A',
            },
            de: {
                refresh: '! Old',
                obsolete: '! Gone',
                reviewOne: 'X',
                reviewTwo: 'Y',
                reviewThree: 'Z',
                returned: '? R',
            },
        })

        const output = formatSyncSummary(synchronizeI18n(syncOptions(directory, baseline)))
        assert.match(output, /2 scaffolds added/)
        assert.match(output, /1 refreshed/)
        assert.match(output, /1 removed/)
        assert.match(output, /3 review requests added/)
        assert.match(output, /1 source-return markers cleared/)
        assert.doesNotMatch(output, /translations?/i)
    })
})

test('no-op summary reports zero operations and no changed files', () => {
    withRepository((directory) => {
        const baseline = commitLocales(
            directory,
            { en: { value: 'A' }, de: { value: 'X' } },
            'baseline'
        )
        const output = formatSyncSummary(synchronizeI18n(syncOptions(directory, baseline)))

        assert.match(output, /de: unchanged/)
        assert.match(
            output,
            /0 scaffolds added, 0 refreshed, 0 removed, 0 review requests added, 0 source-return markers cleared/
        )
        assert.match(output, /No locale files changed/)
        assert.doesNotMatch(output, /translations?/i)
    })
})

const realHistory = describeHistoryAvailability({ cwd: REPOSITORY_ROOT })
const localeWorktreeStatus = git(REPOSITORY_ROOT, ['status', '--porcelain', '--', I18N_LOCALE_DIR])
let unavailableRealSyncReason = false
if (!realHistory.available) {
    unavailableRealSyncReason = 'authoritative real-repository history is unavailable here'
}
if (realHistory.available && localeWorktreeStatus) {
    unavailableRealSyncReason = 'real locale files have uncommitted changes'
}

test(
    'the clean real repository has an authoritative no-op sync plan',
    { skip: unavailableRealSyncReason },
    () => {
        let writes = 0
        const result = synchronizeI18n({
            cwd: REPOSITORY_ROOT,
            write() {
                writes += 1
                throw new Error('Real no-op integration attempted to write a locale file')
            },
        })

        assert.equal(writes, 0)
        assert.deepEqual(result.written, [])
        for (const locale of result.plan.locales) assert.deepEqual(locale.operations, [])

        const summary = summarizeHistory(result.finalHistory)
        for (const locale of summary.locales.values()) {
            for (const entry of locale.entries.values()) {
                if (entry.pendingProvenance !== PENDING_PROVENANCE.EXPLICIT_REQUEST) continue
                assert.equal(entry.state, 'pending')
                assert.equal(entry.acceptedPairSeen, true)
            }
        }
    }
)

test('CLI rejects locale arguments with exit 2 and history failures with exit 1', () => {
    const stdout = { write() {} }
    let error = ''
    const stderr = {
        write(value) {
            error += value
        },
    }
    assert.equal(runI18nSync(['de'], { stdout, stderr }), 2)
    assert.match(error, /Usage: pnpm i18n:sync/)

    withRepository((directory) => {
        commitLocales(directory, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        error = ''
        assert.equal(
            runI18nSync(
                [],
                syncOptions(directory, '0000000000000000000000000000000000000000', {
                    stdout,
                    stderr,
                })
            ),
            1
        )
        assert.match(error, /Full i18n history/)
    })
})

test('CLI reports an injected writer failure with exit 1', () => {
    withRepository((directory) => {
        const baseline = commitLocales(directory, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(directory, { en: { a: 'A', b: 'B' } })
        const stdout = { write() {} }
        let error = ''
        const stderr = {
            write(value) {
                error += value
            },
        }
        const status = runI18nSync(
            [],
            syncOptions(directory, baseline, {
                stdout,
                stderr,
                write: () => {
                    throw new Error('injected writer failure')
                },
            })
        )
        assert.equal(status, 1)
        assert.match(error, /injected writer failure/)
    })
})

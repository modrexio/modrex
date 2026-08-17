import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGitAdapter, GitBlobDecodeError, GitCommandError } from './i18n-git.mjs'
import { entryId, HISTORY_EVENT, PENDING_PROVENANCE } from './i18n-history-events.mjs'
import {
    analyzeCommittedHistory,
    analyzeStaged,
    analyzeWorkingTree,
    describeHistoryAvailability,
    explicitReviewRequests,
    HISTORY_UNAVAILABLE,
    I18nHistoryDataError,
    I18nHistoryStateError,
    I18nHistoryUnavailableError,
    I18N_HISTORY_BASELINE,
    summarizeHistory,
} from './i18n-history.mjs'

const LOCALE_DIR = 'i18n'
const REPO_ROOT = join(import.meta.dirname, '../../..')

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'modrex-i18n-history-'))
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'history@example.test'])
    git(dir, ['config', 'user.name', 'History Test'])
    git(dir, ['config', 'commit.gpgsign', 'false'])
    git(dir, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(dir, LOCALE_DIR), { recursive: true })
    return dir
}

function writeLocales(dir, locales) {
    for (const [id, bundle] of Object.entries(locales)) {
        const path = join(dir, LOCALE_DIR, `${id}.json`)
        if (bundle === null) {
            rmSync(path, { force: true })
            continue
        }
        writeFileSync(path, typeof bundle === 'string' ? bundle : JSON.stringify(bundle, null, 4))
    }
}

function commit(dir, message) {
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', message])
    return git(dir, ['rev-parse', 'HEAD'])
}

function commitLocales(dir, locales, message) {
    writeLocales(dir, locales)
    return commit(dir, message)
}

// Every synthetic repository starts from an audited baseline the same way production does.
function withRepo(run) {
    const dir = createRepo()
    try {
        return run(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function analyze(dir, baseline, options = {}) {
    return analyzeCommittedHistory({ cwd: dir, baseline, localeDir: LOCALE_DIR, ...options })
}

function eventsFor(history, locale, key) {
    return history.events.filter((event) => event.locale === locale && event.key === key)
}

function entryOf(history, locale, key) {
    return summarizeHistory(history).locales.get(locale).entries.get(key)
}

test('baseline accepts ordinary targets and ignores scaffolds', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { greet: 'Hello', bye: 'Bye' }, de: { greet: 'Hallo', bye: '! Bye' } },
            'baseline'
        )
        const history = analyze(dir, baseline)

        assert.equal(entryOf(history, 'de', 'greet').checkpoint.targetText, 'Hallo')
        assert.equal(entryOf(history, 'de', 'greet').checkpoint.sourceText, 'Hello')
        assert.equal(entryOf(history, 'de', 'bye').checkpoint, null)
        assert.equal(entryOf(history, 'de', 'bye').state, 'scaffold')
    })
})

test('a missing baseline object refuses without touching the checkout', () => {
    withRepo((dir) => {
        commitLocales(dir, { en: { greet: 'Hello' } }, 'baseline')
        const absent = '0'.repeat(40)
        assert.throws(
            () => analyze(dir, absent),
            (error) =>
                error instanceof I18nHistoryUnavailableError &&
                error.reason === HISTORY_UNAVAILABLE.BASELINE_MISSING &&
                error.message.includes('This checkout was not modified.')
        )
        const availability = describeHistoryAvailability({
            cwd: dir,
            baseline: absent,
            localeDir: LOCALE_DIR,
        })
        assert.equal(availability.available, false)
        assert.equal(availability.reason, HISTORY_UNAVAILABLE.BASELINE_MISSING)
    })
})

test('a baseline that is not an ancestor refuses', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { greet: 'Hello' } }, 'baseline')
        git(dir, ['checkout', '-q', '--orphan', 'other'])
        const unrelated = commitLocales(dir, { en: { greet: 'Other' } }, 'unrelated')
        assert.notEqual(unrelated, baseline)
        assert.throws(
            () => analyze(dir, baseline, { revision: 'other' }),
            (error) => error.reason === HISTORY_UNAVAILABLE.BASELINE_NOT_ANCESTOR
        )
    })
})

test('a baseline reachable only through a second parent is not authoritative', () => {
    withRepo((dir) => {
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'root')
        git(dir, ['checkout', '-q', '-b', 'side'])
        writeFileSync(join(dir, 'side.txt'), 'side\n')
        const baseline = commit(dir, 'side baseline')

        git(dir, ['checkout', '-q', 'main'])
        writeFileSync(join(dir, 'main.txt'), 'main\n')
        commit(dir, 'main work')
        git(dir, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])

        assert.throws(
            () => analyze(dir, baseline),
            (error) => error.reason === HISTORY_UNAVAILABLE.BASELINE_NOT_FIRST_PARENT
        )
    })
})

test('replacement ancestry cannot fabricate the authoritative baseline', () => {
    withRepo((dir) => {
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'main root')
        const mainHead = git(dir, ['rev-parse', 'HEAD'])
        git(dir, ['checkout', '-q', '--orphan', 'unrelated'])
        const baseline = commitLocales(dir, { en: { a: 'U' }, de: { a: 'V' } }, 'unrelated')
        git(dir, ['checkout', '-q', 'main'])
        git(dir, ['replace', '--graft', mainHead, baseline])

        assert.equal(git(dir, ['merge-base', '--is-ancestor', baseline, mainHead]), '')
        assert.throws(
            () => analyze(dir, baseline, { revision: mainHead }),
            (error) => error.reason === HISTORY_UNAVAILABLE.BASELINE_NOT_ANCESTOR
        )
    })
})

test('legacy graft metadata refuses authoritative history', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        const head = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'edit')
        const grafts = join(dir, '.git', 'info', 'grafts')
        mkdirSync(join(dir, '.git', 'info'), { recursive: true })
        writeFileSync(grafts, `${head} ${baseline}\n`)

        assert.throws(
            () => analyze(dir, baseline),
            (error) => error.reason === HISTORY_UNAVAILABLE.LEGACY_GRAFTS
        )
    })
})

test('a shallow checkout without the baseline refuses and names the shallow cause', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { greet: 'Hello' } }, 'baseline')
        commitLocales(dir, { en: { greet: 'Hello there' } }, 'second')
        const clone = mkdtempSync(join(tmpdir(), 'modrex-i18n-shallow-'))
        try {
            rmSync(clone, { recursive: true, force: true })
            const url = `file:///${dir.replace(/\\/g, '/')}`
            execFileSync('git', ['clone', '-q', '--depth=1', url, clone], { encoding: 'utf8' })
            assert.throws(
                () => analyze(clone, baseline),
                (error) =>
                    error.reason === HISTORY_UNAVAILABLE.BASELINE_MISSING &&
                    error.message.includes('shallow')
            )
        } finally {
            rmSync(clone, { recursive: true, force: true })
        }
    })
})

test('a shallow checkout with only the baseline object still refuses an incomplete path', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'middle')
        commitLocales(dir, { en: { a: 'C' }, de: { a: '? X' } }, 'head')
        const clone = mkdtempSync(join(tmpdir(), 'modrex-i18n-shallow-object-'))
        try {
            rmSync(clone, { recursive: true, force: true })
            const url = `file:///${dir.replace(/\\/g, '/')}`
            execFileSync('git', ['clone', '-q', '--depth=1', url, clone])
            git(clone, ['fetch', '-q', '--depth=1', 'origin', baseline])

            assert.throws(
                () => analyze(clone, baseline),
                (error) => error.reason === HISTORY_UNAVAILABLE.HISTORY_INCOMPLETE
            )
        } finally {
            rmSync(clone, { recursive: true, force: true })
        }
    })
})

test('formatting and key order changes produce no semantic event', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { a: 'A', b: 'B' }, de: { a: 'Ah', b: 'Beh' } },
            'baseline'
        )
        commitLocales(
            dir,
            {
                en: '{\n  "b": "B",\n  "a": "A"\n}\n',
                de: '{\n\t"b": "Beh",\n\t"a": "Ah"\n}\n',
            },
            'reformat'
        )
        const history = analyze(dir, baseline)
        assert.deepEqual(history.events, [])
    })
})

test('nested and flat serialisations of the same leaves are equivalent', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { menu: { open: 'Open' } }, de: { menu: { open: 'Offen' } } },
            'baseline'
        )
        // The same leaves written flat instead of nested: different bytes, identical meaning.
        commitLocales(
            dir,
            { en: { 'menu.open': 'Open' }, de: { 'menu.open': 'Offen' } },
            'flatten serialisation'
        )
        const history = analyze(dir, baseline)
        assert.deepEqual(history.events, [])
        assert.equal(entryOf(history, 'de', 'menu.open').checkpoint.targetText, 'Offen')
    })
})

test('commits that do not touch locales are skipped without losing later events', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        writeFileSync(join(dir, 'README.md'), 'unrelated\n')
        commit(dir, 'docs: unrelated')
        writeFileSync(join(dir, 'other.txt'), 'more\n')
        commit(dir, 'chore: unrelated')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Aha' } }, 'translate')

        const history = analyze(dir, baseline)
        assert.equal(history.revisions.length, 2)
        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.ACCEPTED_EDIT)
    })
})

test('first parent decides history, so branch detail arrives as one merge transition', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        git(dir, ['checkout', '-q', '-b', 'feature'])
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'branch: source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Beh' } }, 'branch: translate')
        git(dir, ['checkout', '-q', 'main'])
        git(dir, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'])

        const history = analyze(dir, baseline)
        assert.equal(history.revisions.length, 2, 'baseline plus the merge commit')
        const events = eventsFor(history, 'de', 'a')
        assert.equal(events.length, 1)
        assert.equal(events[0].kind, HISTORY_EVENT.ACCEPTED_EDIT)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.sourceText, 'B')
    })
})

test('a first translation over a scaffold accepts against the current source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: '! A' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'translate')
        const history = analyze(dir, baseline)
        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.FIRST_TRANSLATION)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.sourceText, 'A')
    })
})

test('a direct target edit accepts the new text against the current source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Aha' } }, 'edit')
        const history = analyze(dir, baseline)
        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.ACCEPTED_EDIT)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'Aha')
    })
})

test('removing a pending marker is a Keep that accepts the current source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Ah' } }, 'keep')
        const history = analyze(dir, baseline)
        const kinds = eventsFor(history, 'de', 'a').map((event) => event.kind)
        assert.deepEqual(kinds, [HISTORY_EVENT.SOURCE_TRIGGERED_PENDING, HISTORY_EVENT.KEEP])
        assert.equal(entryOf(history, 'de', 'a').checkpoint.sourceText, 'B')
        assert.equal(entryOf(history, 'de', 'a').pendingProvenance, null)
    })
})

test('editing out of pending accepts the edited text', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Beh' } }, 'edit')
        const history = analyze(dir, baseline)
        const events = eventsFor(history, 'de', 'a')
        assert.equal(events[1].kind, HISTORY_EVENT.EDIT_FROM_PENDING)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'Beh')
        assert.equal(entryOf(history, 'de', 'a').checkpoint.sourceText, 'B')
    })
})

test('source and target changing together accept against the resulting source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Beh' } }, 'both change')
        const history = analyze(dir, baseline)
        const checkpoint = entryOf(history, 'de', 'a').checkpoint
        assert.equal(checkpoint.sourceText, 'B')
        assert.equal(checkpoint.targetText, 'Beh')
    })
})

test('a source change with an unchanged ordinary target is not an implicit Keep', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Ah' } }, 'source only')
        const history = analyze(dir, baseline)

        assert.deepEqual(eventsFor(history, 'de', 'a'), [])
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.checkpoint.sourceText, 'A', 'checkpoint stays on the reviewed source')
        assert.equal(entry.sourceMatchesCheckpoint, false, 'sync can see that review is owed')
    })
})

test('a source change turns an accepted target into source-triggered pending', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'source change')
        const history = analyze(dir, baseline)
        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.SOURCE_TRIGGERED_PENDING)
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(entry.hasAcceptedLineage, true)
    })
})

test('an unchanged source with a new marker is an explicit review request', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? Ah' } }, 'request review')
        const history = analyze(dir, baseline)

        const event = eventsFor(history, 'de', 'a')[0]
        assert.equal(event.kind, HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED)
        assert.equal(event.sourceChanged, false)
        assert.equal(event.canonicalChanged, false)
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
        assert.equal(entry.checkpoint.targetText, 'Ah', 'the earlier acceptance is still context')
    })
})

// The regression this whole provenance distinction exists for: the current pair is a known
// accepted pair, so pair equality alone would wrongly clear a request nobody answered.
test('an explicit request stays unresolved even though its pair was accepted before', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'B' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'request review')
        const history = analyze(dir, baseline)

        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'pending')
        assert.equal(entry.acceptedPairSeen, true, 'the pair really was accepted before')
        assert.equal(
            entry.pendingProvenance,
            PENDING_PROVENANCE.EXPLICIT_REQUEST,
            'provenance is what stops a source-return clear'
        )
    })
})

test('editing a pending target keeps it pending and accepts nothing', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Beh' } }, 'pending edit')
        const history = analyze(dir, baseline)

        const events = eventsFor(history, 'de', 'a')
        assert.equal(events[1].kind, HISTORY_EVENT.PENDING_EDIT)
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'pending')
        assert.equal(entry.canonicalTarget, 'Beh')
        assert.equal(entry.checkpoint.targetText, 'Ah', 'the edit accepted nothing')
        assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
    })
})

test('further source changes do not stack another marker or new provenance', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'first source change')
        commitLocales(dir, { en: { a: 'C' }, de: { a: '? Ah' } }, 'second source change')
        commitLocales(dir, { en: { a: 'D' }, de: { a: '? Ah' } }, 'third source change')
        const history = analyze(dir, baseline)

        const events = eventsFor(history, 'de', 'a')
        assert.equal(events.length, 1)
        assert.equal(events[0].kind, HISTORY_EVENT.SOURCE_TRIGGERED_PENDING)
        assert.equal(entryOf(history, 'de', 'a').canonicalTarget, 'Ah')
    })
})

test('an explicit request survives a later source change as one pending marker', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'B' }, de: { a: 'Ah' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'request review')
        commitLocales(dir, { en: { a: 'C' }, de: { a: '? Ah' } }, 'later source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Ah' } }, 'source returns')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a').length, 1)
        assert.equal(
            entryOf(history, 'de', 'a').pendingProvenance,
            PENDING_PROVENANCE.EXPLICIT_REQUEST
        )
    })
})

test('a source return exposes the accepted pair that makes a clear eligible', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'source returns')
        const history = analyze(dir, baseline)

        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'pending')
        assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(entry.acceptedPairSeen, true, 'source-triggered pending may clear later')
    })
})

test('a later source-return clear restores the historical checkpoint without accepting again', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'source returns')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'automatic clear')
        const history = analyze(dir, baseline)

        const events = eventsFor(history, 'de', 'a')
        assert.equal(events.at(-1).kind, HISTORY_EVENT.SOURCE_RETURN_CLEARED)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.revision, baseline)
    })
})

test('a source return and marker clear in one transition restores the old checkpoint', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'return and clear')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a').at(-1).kind, HISTORY_EVENT.SOURCE_RETURN_CLEARED)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.revision, baseline)
    })
})

test('resolving an explicit review request is a human Keep', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'B' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'request review')
        const kept = commitLocales(dir, { en: { a: 'B' }, de: { a: 'X' } }, 'keep')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a').at(-1).kind, HISTORY_EVENT.KEEP)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.revision, kept)
    })
})

test('a changed pending target cannot source-return-clear an unaccepted pair', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Y' } }, 'pending edit')
        const kept = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'human keep')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a').at(-1).kind, HISTORY_EVENT.KEEP)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.revision, kept)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'Y')
    })
})

test('a historically accepted pair clears only source-triggered pending', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'Y' } }, 'accepted source edit')
        commitLocales(dir, { en: { a: 'C' }, de: { a: '? Y' } }, 'source pending')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'return and clear')
        const sourceHistory = analyze(dir, baseline)
        assert.equal(
            eventsFor(sourceHistory, 'de', 'a').at(-1).kind,
            HISTORY_EVENT.SOURCE_RETURN_CLEARED
        )

        const explicitRevision = commitLocales(
            dir,
            { en: { a: 'A' }, de: { a: '? Y' } },
            'explicit request'
        )
        const kept = commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'explicit keep')
        const explicitHistory = analyze(dir, baseline)
        const lastTwo = eventsFor(explicitHistory, 'de', 'a').slice(-2)
        assert.equal(lastTwo[0].revision, explicitRevision)
        assert.equal(lastTwo[0].kind, HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED)
        assert.equal(lastTwo[1].kind, HISTORY_EVENT.KEEP)
        assert.equal(entryOf(explicitHistory, 'de', 'a').checkpoint.revision, kept)
    })
})

test('a source return does not make an edited pending target eligible', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? Y' } }, 'pending edit')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? Y' } }, 'source returns')
        const history = analyze(dir, baseline)

        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.canonicalTarget, 'Y')
        assert.equal(entry.acceptedPairSeen, false, 'nobody ever accepted Y against A')
    })
})

test('an unchanged-source target edit into pending is not an explicit review request', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? Y' } }, 'edit while pending')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.PENDING_EDIT)
        assert.equal(explicitReviewRequests(history).length, 0)
        assert.equal(entryOf(history, 'de', 'a').pendingProvenance, PENDING_PROVENANCE.MANUAL_EDIT)
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'X')
        assert.equal(entryOf(history, 'de', 'a').canonicalTarget, 'Y')
    })
})

test('NFC-equivalent marker insertion is an explicit review request', () => {
    withRepo((dir) => {
        const decomposed = 'Gru\u0308n'
        const composed = 'Grün'
        const baseline = commitLocales(
            dir,
            { en: { a: 'Green' }, de: { a: decomposed } },
            'baseline'
        )
        commitLocales(dir, { en: { a: 'Green' }, de: { a: `? ${composed}` } }, 'request')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED)
    })
})

test('withdrawal clears the active checkpoint but keeps the accepted pair on record', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '! A' } }, 'withdraw')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'de', 'a')[0].kind, HISTORY_EVENT.TRANSLATION_WITHDRAWN)
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'scaffold')
        assert.equal(entry.checkpoint, null)

        const historical = history.state.entries.get(entryId('de', 'a'))
        assert.equal(historical.acceptedPairs.size, 1, 'the pair index survives a withdrawal')
    })
})

test('a target removed and recreated is reaccepted rather than resumed', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: {} }, 'remove target')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Z' } }, 'recreate target')
        const history = analyze(dir, baseline)

        const kinds = eventsFor(history, 'de', 'a').map((event) => event.kind)
        assert.deepEqual(kinds, [
            HISTORY_EVENT.TRANSLATION_WITHDRAWN,
            HISTORY_EVENT.FIRST_TRANSLATION,
        ])
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'Z')
    })
})

test('a key deleted and recreated reports both source events', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { a: 'A', b: 'B' }, de: { a: 'X', b: 'Y' } },
            'baseline'
        )
        commitLocales(dir, { en: { b: 'B' }, de: { b: 'Y' } }, 'delete key')
        commitLocales(dir, { en: { a: 'A2', b: 'B' }, de: { a: 'X2', b: 'Y' } }, 'recreate key')
        const history = analyze(dir, baseline)

        const sourceKinds = history.events
            .filter((event) => event.locale === undefined && event.key === 'a')
            .map((event) => event.kind)
        assert.deepEqual(sourceKinds, [HISTORY_EVENT.SOURCE_REMOVED, HISTORY_EVENT.SOURCE_ADDED])
        assert.equal(entryOf(history, 'de', 'a').checkpoint.sourceText, 'A2')
    })
})

test('a locale created after the baseline starts from its own first translations', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' }, uk: { a: 'U' } }, 'add locale')
        const history = analyze(dir, baseline)

        assert.equal(eventsFor(history, 'uk', 'a')[0].kind, HISTORY_EVENT.FIRST_TRANSLATION)
        assert.equal(entryOf(history, 'uk', 'a').checkpoint.sourceText, 'A')
        assert.equal(summarizeHistory(history).locales.get('uk').accepted, 1)
    })
})

test('checkpoints store NFC identity while preserving raw persisted text', () => {
    withRepo((dir) => {
        const rawSource = 'Cafe\u0301'
        const rawTarget = 'Gru\u0308n'
        const compatibilityTarget = 'Ａ'
        const baseline = commitLocales(
            dir,
            {
                en: { a: rawSource, b: 'Letter' },
                de: { a: rawTarget, b: compatibilityTarget },
            },
            'baseline'
        )
        const history = analyze(dir, baseline)
        const checkpoint = entryOf(history, 'de', 'a').checkpoint

        assert.equal(checkpoint.sourceText, 'Café')
        assert.equal(checkpoint.targetText, 'Grün')
        assert.equal(checkpoint.rawSourceText, rawSource)
        assert.equal(checkpoint.rawTargetText, rawTarget)
        assert.equal(entryOf(history, 'de', 'a').acceptedPairSeen, true)
        assert.equal(entryOf(history, 'de', 'b').checkpoint.targetText, compatibilityTarget)
    })
})

test('Pending at the baseline without accepted lineage is rejected', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'baseline')
        assert.throws(
            () => analyze(dir, baseline),
            (error) => error instanceof I18nHistoryStateError && error.locale === 'de'
        )
    })
})

test('a new Pending value without an accepted checkpoint is rejected', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: '! A' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'orphan pending')
        assert.throws(
            () => analyze(dir, baseline),
            (error) => error instanceof I18nHistoryStateError && error.key === 'a'
        )
    })
})

test('repaired intermediate malformed workflow values fail at the malformed revision', async (t) => {
    for (const [name, value] of [
        ['empty Pending', '? '],
        ['nested Pending', '? ? X'],
        ['empty scaffold', '! '],
    ]) {
        await t.test(name, () => {
            withRepo((dir) => {
                const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
                const malformedRevision = commitLocales(
                    dir,
                    { en: { a: 'A' }, de: { a: value } },
                    'malformed'
                )
                commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'repair')

                assert.throws(
                    () => analyze(dir, baseline),
                    (error) =>
                        error instanceof I18nHistoryDataError &&
                        error.message.includes(malformedRevision) &&
                        error.message.includes("key 'a'")
                )
            })
        })
    }
})

test('a scaffold containing marker-like English must still match the current source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        const malformedRevision = commitLocales(
            dir,
            { en: { a: 'A' }, de: { a: '! ? X' } },
            'stale scaffold'
        )
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'repair')

        assert.throws(
            () => analyze(dir, baseline),
            (error) =>
                error instanceof I18nHistoryStateError &&
                error.revision === malformedRevision &&
                error.locale === 'de' &&
                error.key === 'a'
        )
    })
})

test('a scaffold may contain marker-like English when its payload matches the source', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: '? X' }, de: { a: '! ? X' } }, 'withdraw')

        const history = analyze(dir, baseline)
        assert.equal(entryOf(history, 'de', 'a').state, 'scaffold')
    })
})

test('malformed workflow values fail in working-tree and staged overlays', async (t) => {
    await t.test('working tree', () => {
        withRepo((dir) => {
            const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
            writeLocales(dir, { en: { a: 'A' }, de: { a: '? ' } })

            assert.throws(
                () => analyzeWorkingTree({ cwd: dir, baseline, localeDir: LOCALE_DIR }),
                (error) =>
                    error instanceof I18nHistoryDataError &&
                    error.message.includes('de.json@working-tree') &&
                    error.message.includes("key 'a'")
            )
        })
    })

    await t.test('staged index', () => {
        withRepo((dir) => {
            const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
            writeLocales(dir, { en: { a: 'A' }, de: { a: '? ? X' } })
            git(dir, ['add', '-A'])

            assert.throws(
                () => analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR }),
                (error) =>
                    error instanceof I18nHistoryDataError &&
                    error.message.includes('de.json@staged') &&
                    error.message.includes("key 'a'")
            )
        })
    })
})

test('Pending recreation cannot inherit lineage from historical accepted pairs', async (t) => {
    const cases = [
        {
            name: 'target deletion',
            revisions: [
                { en: { a: 'A' }, de: {} },
                { en: { a: 'A' }, de: { a: '? X' } },
            ],
        },
        {
            name: 'changed target after deletion',
            revisions: [
                { en: { a: 'A' }, de: {} },
                { en: { a: 'A' }, de: { a: '? Y' } },
            ],
        },
        {
            name: 'scaffold withdrawal',
            revisions: [
                { en: { a: 'A' }, de: { a: '! A' } },
                { en: { a: 'A' }, de: { a: '? X' } },
            ],
        },
        {
            name: 'changed target after withdrawal',
            revisions: [
                { en: { a: 'A' }, de: { a: '! A' } },
                { en: { a: 'A' }, de: { a: '? Y' } },
            ],
        },
        {
            name: 'locale deletion and recreation',
            revisions: [
                { en: { a: 'A' }, de: null },
                { en: { a: 'A' }, de: { a: '? X' } },
            ],
        },
        {
            name: 'source and target key deletion and recreation',
            revisions: [
                { en: {}, de: {} },
                { en: { a: 'A' }, de: { a: '? X' } },
            ],
        },
    ]

    for (const { name, revisions } of cases) {
        await t.test(name, () => {
            withRepo((dir) => {
                const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
                for (const [index, locales] of revisions.entries()) {
                    commitLocales(dir, locales, `revision ${index + 1}`)
                }

                assert.throws(
                    () => analyze(dir, baseline),
                    (error) =>
                        error instanceof I18nHistoryStateError &&
                        error.locale === 'de' &&
                        error.key === 'a'
                )
            })
        })
    }
})

test('repeated historical acceptances do not legitimize Pending after deletion', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'Y' } }, 'accept Y')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'accept X again')
        commitLocales(dir, { en: { a: 'A' }, de: {} }, 'delete target')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'recreate Pending')

        assert.throws(() => analyze(dir, baseline), I18nHistoryStateError)
    })
})

test('ordinary recreation establishes fresh lineage for later Pending', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: {} }, 'delete target')
        const recreation = commitLocales(
            dir,
            { en: { a: 'A' }, de: { a: 'X' } },
            'recreate accepted'
        )
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'request source review')

        const history = analyze(dir, baseline)
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'pending')
        assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(entry.hasAcceptedLineage, true)
        assert.equal(entry.checkpoint.revision, recreation)
    })
})

test('historical non-string leaves fail instead of becoming semantic absence', async (t) => {
    const malformedValues = [
        ['number', 42],
        ['boolean', true],
        ['null', null],
        ['array', ['text']],
    ]
    for (const position of ['source', 'target']) {
        for (const [type, value] of malformedValues) {
            await t.test(`${position} ${type}`, () => {
                withRepo((dir) => {
                    const baseline = commitLocales(
                        dir,
                        { en: { a: 'A' }, de: { a: 'X' } },
                        'baseline'
                    )
                    const locales =
                        position === 'source'
                            ? { en: { a: value }, de: { a: 'X' } }
                            : { en: { a: 'A' }, de: { a: value } }
                    commitLocales(dir, locales, 'malformed')

                    assert.throws(
                        () => analyze(dir, baseline),
                        (error) =>
                            error instanceof I18nHistoryDataError && error.message.includes("'a'")
                    )
                })
            })
        }
    }
})

test('invalid UTF-8 in a historical blob fails with the blob id', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        const invalid = Buffer.concat([
            Buffer.from('{"a":"', 'ascii'),
            Buffer.from([0xc3, 0x28]),
            Buffer.from('"}', 'ascii'),
        ])
        writeFileSync(join(dir, LOCALE_DIR, 'de.json'), invalid)
        commit(dir, 'invalid utf8')
        const oid = git(dir, ['rev-parse', `HEAD:${LOCALE_DIR}/de.json`])

        assert.throws(
            () => analyze(dir, baseline),
            (error) => error instanceof GitBlobDecodeError && error.oid === oid
        )
    })
})

test('unexpected Git failures are not reported as ordinary missing revisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modrex-i18n-not-a-repo-'))
    try {
        const adapter = createGitAdapter({ cwd: dir })
        assert.throws(() => adapter.resolveRevision('HEAD'), GitCommandError)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

// A squash can erase the Keep that happened inside a branch. The final tree shows only a
// source change, and inventing the missing review is exactly what must not happen.
test('a squashed branch cannot invent the Keep its final tree erased', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: 'X' } }, 'squashed branch')
        const history = analyze(dir, baseline)

        assert.deepEqual(eventsFor(history, 'de', 'a'), [])
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.checkpoint.sourceText, 'A')
        assert.equal(entry.sourceMatchesCheckpoint, false)
    })
})

test('a squashed final tree that still shows the marker keeps explicit provenance', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'A' }, de: { a: '? X' } }, 'squashed review request')
        const history = analyze(dir, baseline)
        assert.equal(
            entryOf(history, 'de', 'a').pendingProvenance,
            PENDING_PROVENANCE.EXPLICIT_REQUEST
        )
    })
})

test('an uncommitted Keep is read from the working tree', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        writeLocales(dir, { en: { a: 'B' }, de: { a: 'X' } })

        const history = analyzeWorkingTree({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        const entry = entryOf(history, 'de', 'a')
        assert.equal(entry.state, 'accepted')
        assert.equal(entry.checkpoint.sourceText, 'B')
        assert.equal(entry.pendingProvenance, null)
    })
})

test('an uncommitted target edit is read from the working tree', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(dir, { en: { a: 'A' }, de: { a: 'Z' } })

        const history = analyzeWorkingTree({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        assert.equal(entryOf(history, 'de', 'a').checkpoint.targetText, 'Z')
    })
})

test('an uncommitted marker with an unchanged source is an explicit request', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(dir, { en: { a: 'A' }, de: { a: '? X' } })

        const history = analyzeWorkingTree({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        assert.equal(
            entryOf(history, 'de', 'a').pendingProvenance,
            PENDING_PROVENANCE.EXPLICIT_REQUEST
        )
    })
})

test('a no-op working overlay preserves committed events and committed state', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        const committed = analyze(dir, baseline)
        const checkpoint = committed.state.entries.get(entryId('de', 'a')).checkpoint
        const working = analyzeWorkingTree({
            cwd: dir,
            localeDir: LOCALE_DIR,
            history: committed,
        })

        assert.deepEqual(working.committedEvents, committed.events)
        assert.deepEqual(working.events, committed.events)
        assert.deepEqual(working.prospectiveEvents, [])
        assert.notEqual(working.state, committed.state)
        assert.equal(committed.state.entries.get(entryId('de', 'a')).checkpoint, checkpoint)
    })
})

test('a staged Keep is recognised and unstaged work is ignored', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')

        writeLocales(dir, { en: { a: 'B' }, de: { a: 'X' } })
        git(dir, ['add', '-A'])
        // Only in the working tree, so a staged analysis must not see it.
        writeLocales(dir, { en: { a: 'B' }, de: { a: 'UNSTAGED' } })

        const staged = analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        const entry = entryOf(staged, 'de', 'a')
        assert.equal(entry.state, 'accepted')
        assert.equal(entry.canonicalTarget, 'X')
        assert.equal(entry.checkpoint.sourceText, 'B')
        assert.equal(staged.committedEvents.length, 2)
        assert.equal(staged.prospectiveEvents.length, 1)
        assert.equal(staged.events.length, 3)
        assert.equal(staged.prospectiveEvents[0].kind, HISTORY_EVENT.KEEP)

        const working = analyzeWorkingTree({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        assert.equal(entryOf(working, 'de', 'a').canonicalTarget, 'UNSTAGED')
    })
})

test('a staged analysis ignores an unstaged fix that would complete it', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(dir, { en: { a: 'B' }, de: { a: 'X' } })
        git(dir, ['add', '-A'])
        writeLocales(dir, { en: { a: 'B' }, de: { a: '? X' } })

        const staged = analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        const entry = entryOf(staged, 'de', 'a')
        assert.equal(entry.state, 'accepted')
        assert.equal(entry.sourceMatchesCheckpoint, false, 'the staged tree still owes review')
    })
})

test('a staged pending edit ignores a different unstaged target', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        commitLocales(dir, { en: { a: 'B' }, de: { a: '? X' } }, 'source change')
        writeLocales(dir, { en: { a: 'B' }, de: { a: 'Y' } })
        git(dir, ['add', '-A'])
        writeLocales(dir, { en: { a: 'B' }, de: { a: 'UNSTAGED' } })

        const staged = analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR })
        assert.equal(staged.prospectiveEvents[0].kind, HISTORY_EVENT.EDIT_FROM_PENDING)
        assert.equal(entryOf(staged, 'de', 'a').canonicalTarget, 'Y')
        assert.equal(entryOf(staged, 'de', 'a').checkpoint.targetText, 'Y')
    })
})

test('staged additions and deletions are reconstructed prospectively', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { a: 'A', b: 'B' }, de: { a: 'X', b: 'Y' } },
            'baseline'
        )
        writeLocales(dir, {
            en: { a: 'A', b: 'B' },
            de: { a: 'X' },
            uk: { a: 'U', b: 'V' },
        })
        git(dir, ['add', '-A'])
        const staged = analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR })

        assert.equal(staged.state.entries.get(entryId('de', 'b')).checkpoint, null)
        assert.equal(entryOf(staged, 'uk', 'a').checkpoint.targetText, 'U')
        assert.equal(entryOf(staged, 'uk', 'b').checkpoint.targetText, 'V')
        assert.ok(staged.prospectiveEvents.length >= 3)
    })
})

test('malformed staged locale data fails closed', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        writeLocales(dir, { en: { a: 'A' }, de: { a: 42 } })
        git(dir, ['add', '-A'])

        assert.throws(
            () => analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR }),
            I18nHistoryDataError
        )
    })
})

test('staged conflict diagnostics deduplicate the conflicted path', () => {
    withRepo((dir) => {
        const baseline = commitLocales(dir, { en: { a: 'A' }, de: { a: 'X' } }, 'baseline')
        git(dir, ['checkout', '-q', '-b', 'feature'])
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'FEATURE' } }, 'feature edit')
        git(dir, ['checkout', '-q', 'main'])
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'MAIN' } }, 'main edit')
        assert.throws(() => git(dir, ['merge', '--no-edit', 'feature']))

        assert.throws(
            () => analyzeStaged({ cwd: dir, baseline, localeDir: LOCALE_DIR }),
            (error) => {
                const path = `${LOCALE_DIR}/de.json`
                return error.message.split(path).length - 1 === 1
            }
        )
    })
})

test('each unique blob is read once and parsed once across the whole walk', () => {
    withRepo((dir) => {
        const baseline = commitLocales(
            dir,
            { en: { a: 'A' }, de: { a: 'X' }, uk: { a: 'U' } },
            'baseline'
        )
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X2' }, uk: { a: 'U' } }, 'de edit')
        commitLocales(dir, { en: { a: 'A' }, de: { a: 'X3' }, uk: { a: 'U' } }, 'de edit again')

        const git4 = createGitAdapter({ cwd: dir })
        const history = analyze(dir, baseline, { git: git4 })

        // en and uk never change, so their single blob is shared by all four snapshots.
        const uniqueBlobs = 3 + 1 + 1
        assert.equal(history.stats.blobLoads, uniqueBlobs)
        assert.equal(history.stats.bundleParses, uniqueBlobs)
        assert.equal(history.stats.revisions, 3)
    })
})

test('git work scales with revisions, never with keys', () => {
    withRepo((dir) => {
        const wide = Object.fromEntries(
            Array.from({ length: 60 }, (_, index) => [`k${index}`, `S${index}`])
        )
        const target = Object.fromEntries(Object.keys(wide).map((key) => [key, `T:${key}`]))
        const baseline = commitLocales(dir, { en: wide, de: target }, 'baseline')
        commitLocales(dir, { en: wide, de: { ...target, k0: 'changed' } }, 'one edit')

        const adapter = createGitAdapter({ cwd: dir })
        const history = analyze(dir, baseline, { git: adapter })

        assert.equal(history.stats.revisions, 2)
        // Resolve head and baseline, find grafts, prove the full first-parent chain, find
        // relevant revisions, load one tree per revision, then batch all unique blobs.
        assert.equal(history.stats.gitCalls, 8)
        assert.ok(history.events.length >= 1)
    })
})

// A shallow checkout cannot prove the baseline path, which is the refusal the engine is
// specified to produce. These two assert against real history, so they run wherever it
// exists and report why they cannot run where it does not.
const realHistory = describeHistoryAvailability({ cwd: REPO_ROOT })
const withoutRealHistory = realHistory.available
    ? false
    : `authoritative history through ${I18N_HISTORY_BASELINE} is unavailable here`

test(
    'the real repository reconstructs exactly the four explicit review requests',
    {
        skip: withoutRealHistory,
    },
    () => {
        const history = analyzeCommittedHistory({ cwd: REPO_ROOT })
        assert.equal(history.baseline, I18N_HISTORY_BASELINE)

        const requests = explicitReviewRequests(history)
        const byLocale = new Map()
        for (const event of requests) {
            byLocale.set(event.locale, [...(byLocale.get(event.locale) ?? []), event.key].sort())
        }

        assert.equal(requests.length, 4)
        assert.deepEqual(byLocale.get('de'), [
            'installed.health.unidentifiedHint',
            'installed.health.unidentifiedRowHint',
        ])
        assert.deepEqual(byLocale.get('ru'), [
            'installed.health.unidentifiedHint',
            'installed.health.unidentifiedRowHint',
        ])
        assert.equal(byLocale.get('uk'), undefined)

        for (const event of requests) {
            assert.equal(event.sourceChanged, false)
            assert.equal(event.canonicalChanged, false)
            const entry = entryOf(history, event.locale, event.key)
            assert.equal(entry.state, 'pending')
            assert.equal(entry.pendingProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
            assert.equal(entry.hasAcceptedLineage, true)
            assert.equal(entry.acceptedPairSeen, true)
            assert.equal(entry.checkpoint.revision, I18N_HISTORY_BASELINE)
        }
    }
)

test(
    'the real repository reports its current accepted and pending totals',
    {
        skip: withoutRealHistory,
    },
    () => {
        const summary = summarizeHistory(analyzeCommittedHistory({ cwd: REPO_ROOT }))
        assert.deepEqual(
            [...summary.locales]
                .map(([id, locale]) => [id, locale.accepted, locale.pending])
                .sort(),
            [
                ['de', 420, 2],
                ['ru', 420, 2],
                ['uk', 422, 0],
            ]
        )
    }
)

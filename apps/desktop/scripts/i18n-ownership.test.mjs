import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    parseSourceValue,
    parseTargetValue,
    resolveTargetValue,
} from '../src/shared/i18n-values.js'
import { serializeLocale } from './i18n-files.mjs'
import { HISTORY_EVENT, PENDING_PROVENANCE } from './i18n-history-events.mjs'
import { analyzeCommittedHistory, summarizeHistory } from './i18n-history.mjs'
import { runI18nValidation } from './check-i18n.mjs'
import {
    applyReviewAction,
    prepareI18nReview,
    reviewEditProblems,
    REVIEW_ACTION,
} from './i18n-review.mjs'
import { synchronizeI18n } from './i18n-sync.mjs'

// Contributors change English alone and a separate bot commit materializes the derived
// markers later. Every scenario here therefore commits English by itself first, then runs
// the real synchronizer as its own commit, so the delay is part of the recorded history
// rather than something the assertions arrange away.

const LOCALE_DIR = 'i18n'

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepo() {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-ownership-'))
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'ownership@example.test'])
    git(cwd, ['config', 'user.name', 'Ownership Test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(cwd, LOCALE_DIR), { recursive: true })
    return cwd
}

function write(cwd, locales) {
    for (const [id, bundle] of Object.entries(locales)) {
        writeFileSync(join(cwd, LOCALE_DIR, `${id}.json`), serializeLocale(bundle))
    }
}

function commit(cwd, locales, message) {
    write(cwd, locales)
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-q', '-m', message])
    return git(cwd, ['rev-parse', 'HEAD'])
}

function readLocale(cwd, id) {
    return JSON.parse(readFileSync(join(cwd, LOCALE_DIR, `${id}.json`), 'utf8'))
}

// The bot's contribution: run the real synchronizer over the checkout, then commit exactly
// what it wrote. A scenario that expects no bot output asserts on the empty return value.
function botCommit(cwd, baseline, message = 'bot: sync') {
    const result = synchronizeI18n({ cwd, localeDir: LOCALE_DIR, baseline })
    if (result.written.length > 0) {
        git(cwd, ['add', '-A'])
        git(cwd, ['commit', '-q', '-m', message])
    }
    return result
}

function withRepo(run) {
    const cwd = createRepo()
    try {
        return run(cwd)
    } finally {
        rmSync(cwd, { recursive: true, force: true })
    }
}

async function withRepoAsync(run) {
    const cwd = createRepo()
    try {
        return await run(cwd)
    } finally {
        rmSync(cwd, { recursive: true, force: true })
    }
}

// What a contributor sees from pnpm check-i18n against this checkout.
async function validate(cwd, baseline) {
    let out = ''
    const stream = { write: (chunk) => (out += chunk) }
    const status = await runI18nValidation({
        cwd,
        baseline,
        localeDir: LOCALE_DIR,
        i18nDir: join(cwd, LOCALE_DIR),
        stdout: stream,
        stderr: stream,
    })
    return { status, out }
}

function analyze(cwd, baseline) {
    return analyzeCommittedHistory({ cwd, baseline, localeDir: LOCALE_DIR })
}

function entryOf(cwd, baseline, locale, key) {
    const history = analyze(cwd, baseline)
    return summarizeHistory(history).locales.get(locale).entries.get(key)
}

function eventsAt(history, revision, locale, key) {
    return history.events
        .filter(
            (event) => event.revision === revision && event.locale === locale && event.key === key
        )
        .map((event) => event.kind)
}

// What the desktop bundle would render for this key at the current checkout.
function rendered(cwd, key, locale) {
    const source = parseSourceValue(readLocale(cwd, 'en')[key])
    return resolveTargetValue(source, parseTargetValue(readLocale(cwd, locale)[key]))
}

test('new English key stays Missing before and after the bot commit', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Hello', bye: 'Bye' } }, 'english only')

        const before = entryOf(cwd, baseline, 'de', 'bye')
        assert.equal(before.effectiveState, 'missing')
        assert.equal(rendered(cwd, 'bye', 'de'), 'Bye')

        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').bye, '! Bye')

        const after = entryOf(cwd, baseline, 'de', 'bye')
        assert.equal(after.effectiveState, 'missing')
        assert.equal(after.checkpoint, null)
        assert.equal(rendered(cwd, 'bye', 'de'), 'Bye')
    })
})

test('changed English marks Review before the bot and the marker keeps its provenance', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')

        const before = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(before.effectiveState, 'review')
        assert.equal(before.effectiveProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(before.lineageCheckpoint.rawSourceText, 'Hello')
        assert.equal(before.lineageCheckpoint.rawTargetText, 'Hallo')

        const bot = botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        const history = analyze(cwd, baseline)
        const revision = git(cwd, ['rev-parse', 'HEAD'])
        assert.deepEqual(eventsAt(history, revision, 'de', 'greet'), [
            HISTORY_EVENT.REVIEW_MARKER_MATERIALIZED,
        ])

        const after = summarizeHistory(history).locales.get('de').entries.get('greet')
        assert.equal(after.effectiveState, 'review')
        assert.equal(after.effectiveProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(after.lineageCheckpoint.rawSourceText, 'Hello')
        assert.equal(after.lineageCheckpoint.rawTargetText, 'Hallo')
        // The bot wrote a marker, not an acceptance of the new English meaning.
        assert.equal(after.acceptedPairSeen, false)
        assert.equal(bot.written.length, 1)
    })
})

test('changed English placeholders keep the English fallback across the bot commit', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Hello {name}' } }, 'english only')

        assert.equal(entryOf(cwd, baseline, 'de', 'greet').effectiveState, 'review')
        assert.equal(rendered(cwd, 'greet', 'de'), 'Hello {name}')

        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        assert.equal(entryOf(cwd, baseline, 'de', 'greet').effectiveState, 'review')
        assert.equal(rendered(cwd, 'greet', 'de'), 'Hello {name}')
    })
})

test('English changing over a stale scaffold stays replayable and never becomes Accepted', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { bye: 'Bye' }, de: { bye: '! Bye' } }, 'baseline')
        commit(cwd, { en: { bye: 'Goodbye' } }, 'english only')

        // The intermediate commit carries a scaffold quoting superseded English. That is
        // derived drift the bot has not caught up with, not a corrupt translation.
        const before = entryOf(cwd, baseline, 'de', 'bye')
        assert.equal(before.effectiveState, 'missing')

        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').bye, '! Goodbye')

        const after = entryOf(cwd, baseline, 'de', 'bye')
        assert.equal(after.effectiveState, 'missing')
        assert.equal(after.checkpoint, null)
    })
})

test('repeated English changes before one bot run keep the original accepted lineage', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')
        commit(cwd, { en: { greet: 'Greetings' } }, 'english only again')

        const before = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(before.effectiveState, 'review')
        assert.equal(before.lineageCheckpoint.rawSourceText, 'Hello')
        assert.equal(before.sourceText, 'Greetings')

        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        const after = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(after.effectiveState, 'review')
        assert.equal(after.effectiveProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)
        assert.equal(after.lineageCheckpoint.rawSourceText, 'Hello')
        assert.equal(after.lineageCheckpoint.rawTargetText, 'Hallo')
    })
})

test('English reverting after a delayed marker clears it back to the accepted pair', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')
        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        commit(cwd, { en: { greet: 'Hello' } }, 'english reverted')
        botCommit(cwd, baseline, 'bot: clear source return')

        assert.equal(readLocale(cwd, 'de').greet, 'Hallo')
        const entry = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(entry.effectiveState, 'accepted')
        assert.equal(entry.checkpoint.rawSourceText, 'Hello')
        assert.equal(entry.checkpoint.rawTargetText, 'Hallo')
    })
})

test('an explicit human review request survives a bot run and matching English', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { de: { greet: '? Hallo' } }, 'translator requests review')

        const requested = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(requested.effectiveState, 'review')
        assert.equal(requested.effectiveProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)

        // English never moved, so the historically accepted pair is still the current pair.
        // That must not be read as permission to clear somebody's review request.
        const bot = botCommit(cwd, baseline)
        assert.deepEqual(bot.written, [])
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        const after = entryOf(cwd, baseline, 'de', 'greet')
        assert.equal(after.effectiveState, 'review')
        assert.equal(after.effectiveProvenance, PENDING_PROVENANCE.EXPLICIT_REQUEST)
    })
})

test('a translator Keep after a delayed marker accepts against the current English', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')
        botCommit(cwd, baseline)

        const kept = commit(cwd, { de: { greet: 'Hallo' } }, 'translator keeps')
        const history = analyze(cwd, baseline)
        assert.deepEqual(eventsAt(history, kept, 'de', 'greet'), [HISTORY_EVENT.KEEP])

        const entry = summarizeHistory(history).locales.get('de').entries.get('greet')
        assert.equal(entry.effectiveState, 'accepted')
        assert.equal(entry.checkpoint.rawSourceText, 'Welcome')
        assert.equal(entry.checkpoint.rawTargetText, 'Hallo')

        // Synchronization must not reopen a review the translator just closed.
        assert.deepEqual(botCommit(cwd, baseline).written, [])
        assert.equal(readLocale(cwd, 'de').greet, 'Hallo')
    })
})

test('a translator Edit after a delayed marker accepts the new text', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')
        botCommit(cwd, baseline)

        const edited = commit(cwd, { de: { greet: 'Willkommen' } }, 'translator edits')
        const history = analyze(cwd, baseline)
        assert.deepEqual(eventsAt(history, edited, 'de', 'greet'), [
            HISTORY_EVENT.EDIT_FROM_PENDING,
        ])

        const entry = summarizeHistory(history).locales.get('de').entries.get('greet')
        assert.equal(entry.effectiveState, 'accepted')
        assert.equal(entry.checkpoint.rawSourceText, 'Welcome')
        assert.equal(entry.checkpoint.rawTargetText, 'Willkommen')
        assert.deepEqual(botCommit(cwd, baseline).written, [])
    })
})

test('review surfaces an unwritten Review and refuses a Keep that Git could not record', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')

        const before = prepareI18nReview({
            cwd,
            baseline,
            localeDir: LOCALE_DIR,
            i18nDir: join(cwd, LOCALE_DIR),
            localeId: 'de',
        })
        assert.equal(before.candidates.length, 1)
        assert.equal(before.candidates[0].materialized, false)
        assert.equal(before.candidates[0].pendingProvenance, PENDING_PROVENANCE.SOURCE_CHANGE)

        // Keeping here would write the bytes already committed, so no acceptance would exist.
        assert.throws(
            () => applyReviewAction(before.candidates[0], REVIEW_ACTION.KEEP),
            /no acceptance could be recorded/u
        )
        // Nor can an Edit that retypes the committed text sneak past that.
        assert.deepEqual(reviewEditProblems(before.candidates[0], 'Hallo'), [
            'This is identical to the committed value, so Git would record no acceptance.',
        ])
        // Editing writes real new text, so it needs no marker first.
        assert.deepEqual(
            applyReviewAction(before.candidates[0], REVIEW_ACTION.EDIT, 'Willkommen'),
            { changed: true, storedValue: 'Willkommen' }
        )

        botCommit(cwd, baseline)
        const after = prepareI18nReview({
            cwd,
            baseline,
            localeDir: LOCALE_DIR,
            i18nDir: join(cwd, LOCALE_DIR),
            localeId: 'de',
        })
        assert.equal(after.candidates[0].materialized, true)
        assert.deepEqual(applyReviewAction(after.candidates[0], REVIEW_ACTION.KEEP), {
            changed: true,
            storedValue: 'Hallo',
        })
    })
})

test('the English-fallback notice counts a Review whose marker is not written yet', async () => {
    await withRepoAsync(async (cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Hello {name}' } }, 'english only')

        // The target has no {name}, so the app already renders English for this key. The
        // notice has to say so now, not once the bot has written the '? '.
        const before = await validate(cwd, baseline)
        assert.equal(before.status, 0)
        assert.match(before.out, /de: 1\/1 \(100%\), 0 accepted, 1 review, 0 missing/u)
        assert.match(before.out, /1 review-pending translation uses English fallback/u)

        botCommit(cwd, baseline)
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        // Writing the marker changes nothing about what the app shows, so the count holds.
        const after = await validate(cwd, baseline)
        assert.equal(after.status, 0)
        assert.match(after.out, /1 review-pending translation uses English fallback/u)
    })
})

test('a compatible Review is not reported as using the English fallback', async () => {
    await withRepoAsync(async (cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')

        const result = await validate(cwd, baseline)
        assert.equal(result.status, 0)
        assert.match(result.out, /0 accepted, 1 review, 0 missing/u)
        assert.doesNotMatch(result.out, /English fallback/u)
    })
})

test('an uncommitted sync does not make a Keep recordable', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Welcome' } }, 'english only')

        // Sync writes the marker but nothing commits it, so HEAD still holds 'Hallo'.
        synchronizeI18n({ cwd, localeDir: LOCALE_DIR, baseline })
        assert.equal(readLocale(cwd, 'de').greet, '? Hallo')

        const candidate = prepareI18nReview({
            cwd,
            baseline,
            localeDir: LOCALE_DIR,
            i18nDir: join(cwd, LOCALE_DIR),
            localeId: 'de',
        }).candidates[0]

        // Keeping would write 'Hallo' over 'Hallo': an empty diff, and no acceptance.
        assert.equal(candidate.materialized, false)
        assert.throws(
            () => applyReviewAction(candidate, REVIEW_ACTION.KEEP),
            /no acceptance could be recorded/u
        )
        assert.deepEqual(reviewEditProblems(candidate, 'Hallo'), [
            'This is identical to the committed value, so Git would record no acceptance.',
        ])
        // A real edit is recordable even before the marker is committed.
        assert.deepEqual(reviewEditProblems(candidate, 'Willkommen'), [])
    })
})

test('changed English placeholders can be reviewed before the bot writes the marker', () => {
    withRepo((cwd) => {
        const baseline = commit(cwd, { en: { greet: 'Hello' }, de: { greet: 'Hallo' } }, 'baseline')
        commit(cwd, { en: { greet: 'Hello {name}' } }, 'english only')

        // The old target has no {name}. That is the debt review exists to resolve, so it must
        // reach the prompt instead of failing structural validation.
        const candidate = prepareI18nReview({
            cwd,
            baseline,
            localeDir: LOCALE_DIR,
            i18nDir: join(cwd, LOCALE_DIR),
            localeId: 'de',
        }).candidates[0]

        assert.equal(candidate.key, 'greet')
        assert.equal(candidate.placeholderCompatible, false)
        assert.throws(
            () => applyReviewAction(candidate, REVIEW_ACTION.KEEP),
            /incompatible placeholders/u
        )
        assert.deepEqual(reviewEditProblems(candidate, 'Hallo {name}'), [])
    })
})

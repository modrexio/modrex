import { TARGET_VALUE_KIND } from '../src/shared/i18n-values.js'

// Pure reconstruction: two semantic snapshots in, workflow events out, then events folded
// into accepted-checkpoint state. Nothing here touches Git, the filesystem, or the clock,
// so every transition rule in the design can be tested directly.

export const HISTORY_EVENT = Object.freeze({
    SOURCE_ADDED: 'source-added',
    SOURCE_CHANGED: 'source-changed',
    SOURCE_REMOVED: 'source-removed',
    FIRST_TRANSLATION: 'first-translation',
    ACCEPTED_EDIT: 'accepted-edit',
    KEEP: 'keep',
    EDIT_FROM_PENDING: 'edit-from-pending',
    SOURCE_TRIGGERED_PENDING: 'source-triggered-pending',
    EXPLICIT_REVIEW_REQUESTED: 'explicit-review-requested',
    REVIEW_MARKER_MATERIALIZED: 'review-marker-materialized',
    PENDING_EDIT: 'pending-edit',
    PENDING_CREATED: 'pending-created',
    SOURCE_RETURN_CLEARED: 'source-return-cleared',
    SCAFFOLD_CREATED: 'scaffold-created',
    SCAFFOLD_REFRESHED: 'scaffold-refreshed',
    TRANSLATION_WITHDRAWN: 'translation-withdrawn',
    TARGET_REMOVED: 'target-removed',
})

export const PENDING_PROVENANCE = Object.freeze({
    SOURCE_CHANGE: 'source-triggered',
    EXPLICIT_REQUEST: 'explicit-review-requested',
    MANUAL_EDIT: 'manual-pending-edit',
    BASELINE: 'baseline',
    ORPHAN: 'orphan',
})

// Locale ids and dotted keys never contain a control character, so this cannot collide
// with either half of a composed identity.
const KEY_SEPARATOR = '\u0000'

export function entryId(locale, key) {
    return `${locale}${KEY_SEPARATOR}${key}`
}

const ACCEPTING_EVENTS = new Set([
    HISTORY_EVENT.FIRST_TRANSLATION,
    HISTORY_EVENT.ACCEPTED_EDIT,
    HISTORY_EVENT.KEEP,
    HISTORY_EVENT.EDIT_FROM_PENDING,
])

const PENDING_EVENTS = new Set([
    HISTORY_EVENT.SOURCE_TRIGGERED_PENDING,
    HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED,
    HISTORY_EVENT.PENDING_CREATED,
])

export function normalize(text) {
    return typeof text === 'string' ? text.normalize('NFC') : text
}

export function pairKey(sourceText, targetText) {
    return `${normalize(sourceText)}${KEY_SEPARATOR}${normalize(targetText)}`
}

function canonicalTargetText(value) {
    if (!value) return undefined
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return value.targetText
    if (value.kind === TARGET_VALUE_KIND.PENDING) return value.targetText
    return undefined
}

function sameText(left, right) {
    if (left === undefined || right === undefined) return false
    return normalize(left) === normalize(right)
}

function localeKeys(snapshot, localeId) {
    const locale = snapshot.locales.get(localeId)
    return locale ? locale.targets.keys() : [].values()
}

function targetAt(snapshot, localeId, key) {
    const locale = snapshot.locales.get(localeId)
    if (!locale) return { kind: TARGET_VALUE_KIND.ABSENT }
    return locale.targets.get(key) ?? { kind: TARGET_VALUE_KIND.ABSENT }
}

function classifyAcceptedResult(previous, canonicalNext) {
    if (previous.kind === TARGET_VALUE_KIND.ACCEPTED) {
        // An ordinary target that did not change is not an event, even when the source did.
        // Treating it as an implicit Keep would silently accept text nobody reviewed.
        if (sameText(previous.targetText, canonicalNext)) return undefined
        return HISTORY_EVENT.ACCEPTED_EDIT
    }
    if (previous.kind === TARGET_VALUE_KIND.PENDING) {
        return sameText(previous.targetText, canonicalNext)
            ? HISTORY_EVENT.KEEP
            : HISTORY_EVENT.EDIT_FROM_PENDING
    }
    return HISTORY_EVENT.FIRST_TRANSLATION
}

// An accepted-to-pending transition is classified from the same tree transition. A source
// change creates source-triggered pending. With an unchanged source, unchanged canonical
// text requests review and changed canonical text remains a non-accepting pending edit.
function classifyPendingResult(previous, sourceChanged, canonicalChanged) {
    if (previous.kind === TARGET_VALUE_KIND.PENDING) return HISTORY_EVENT.PENDING_EDIT
    if (previous.kind !== TARGET_VALUE_KIND.ACCEPTED) return HISTORY_EVENT.PENDING_CREATED
    if (sourceChanged) return HISTORY_EVENT.SOURCE_TRIGGERED_PENDING
    if (!canonicalChanged) return HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED
    return HISTORY_EVENT.PENDING_EDIT
}

function classifyScaffoldResult(previous, nextValue) {
    if (
        previous.kind === TARGET_VALUE_KIND.ACCEPTED ||
        previous.kind === TARGET_VALUE_KIND.PENDING
    ) {
        return HISTORY_EVENT.TRANSLATION_WITHDRAWN
    }
    if (previous.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        return sameText(previous.sourceText, nextValue.sourceText)
            ? undefined
            : HISTORY_EVENT.SCAFFOLD_REFRESHED
    }
    return HISTORY_EVENT.SCAFFOLD_CREATED
}

function classifyAbsentResult(previous) {
    if (
        previous.kind === TARGET_VALUE_KIND.ACCEPTED ||
        previous.kind === TARGET_VALUE_KIND.PENDING
    ) {
        return HISTORY_EVENT.TRANSLATION_WITHDRAWN
    }
    if (previous.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        return HISTORY_EVENT.TARGET_REMOVED
    }
    return undefined
}

function sourceEvents(previous, next, revision) {
    const events = []
    const keys = new Set([...previous.source.keys(), ...next.source.keys()])
    for (const key of [...keys].sort()) {
        const before = previous.source.get(key)
        const after = next.source.get(key)
        if (before === undefined && after === undefined) continue
        if (before === undefined) {
            events.push({ kind: HISTORY_EVENT.SOURCE_ADDED, key, revision, sourceText: after })
            continue
        }
        if (after === undefined) {
            events.push({ kind: HISTORY_EVENT.SOURCE_REMOVED, key, revision, sourceText: before })
            continue
        }
        if (sameText(before, after)) continue
        events.push({
            kind: HISTORY_EVENT.SOURCE_CHANGED,
            key,
            revision,
            previousSourceText: before,
            sourceText: after,
        })
    }
    return events
}

function targetEvent(previous, next, localeId, key, revision) {
    const before = targetAt(previous, localeId, key)
    const after = targetAt(next, localeId, key)
    const previousSource = previous.source.get(key)
    const nextSource = next.source.get(key)
    const sourceChanged =
        previousSource !== undefined && nextSource !== undefined
            ? !sameText(previousSource, nextSource)
            : previousSource !== nextSource

    const base = {
        locale: localeId,
        key,
        revision,
        sourceText: nextSource,
        previousSourceText: previousSource,
        sourceChanged,
        previousKind: before.kind,
    }

    if (after.kind === TARGET_VALUE_KIND.ACCEPTED) {
        const kind = classifyAcceptedResult(before, after.targetText)
        if (!kind) return undefined
        return { ...base, kind, targetText: after.targetText }
    }

    if (after.kind === TARGET_VALUE_KIND.PENDING) {
        const canonicalChanged = !sameText(canonicalTargetText(before), after.targetText)
        const kind = classifyPendingResult(before, sourceChanged, canonicalChanged)
        if (kind === HISTORY_EVENT.PENDING_EDIT && !canonicalChanged) return undefined
        return { ...base, kind, targetText: after.targetText, canonicalChanged }
    }

    if (after.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
        const kind = classifyScaffoldResult(before, after)
        if (!kind) return undefined
        return { ...base, kind, scaffoldText: after.sourceText }
    }

    const kind = classifyAbsentResult(before)
    if (!kind) return undefined
    return { ...base, kind }
}

export function analyzeTransition(previous, next, revision) {
    const events = sourceEvents(previous, next, revision)
    const locales = new Set([...previous.locales.keys(), ...next.locales.keys()])
    for (const localeId of [...locales].sort()) {
        const keys = new Set([...localeKeys(previous, localeId), ...localeKeys(next, localeId)])
        for (const key of [...keys].sort()) {
            const event = targetEvent(previous, next, localeId, key, revision)
            if (event) events.push(event)
        }
    }
    return events
}

export function createHistoryState() {
    return { entries: new Map(), byKey: new Map() }
}

// A source change invalidates every locale's acceptance of that key at once, so the reducer
// needs the entries for a key without scanning the whole table on each source event.
function indexEntry(state, entry) {
    let siblings = state.byKey.get(entry.key)
    if (!siblings) {
        siblings = []
        state.byKey.set(entry.key, siblings)
    }
    siblings.push(entry)
}

function entryFor(state, localeId, key) {
    const id = entryId(localeId, key)
    let entry = state.entries.get(id)
    if (!entry) {
        entry = { locale: localeId, key, checkpoint: null, pending: null, acceptedPairs: new Map() }
        state.entries.set(id, entry)
        indexEntry(state, entry)
    }
    return entry
}

export function cloneHistoryState(state) {
    const copy = createHistoryState()
    for (const [id, entry] of state.entries) {
        const clone = {
            locale: entry.locale,
            key: entry.key,
            checkpoint: entry.checkpoint,
            pending: entry.pending,
            acceptedPairs: new Map(entry.acceptedPairs),
        }
        copy.entries.set(id, clone)
        indexEntry(copy, clone)
    }
    return copy
}

// A withdrawal clears the active checkpoint but never the pair index: a later source return
// still has to be able to ask whether this exact pair was ever accepted.
function recordAcceptance(entry, event) {
    const checkpoint = {
        sourceText: normalize(event.sourceText),
        targetText: normalize(event.targetText),
        rawSourceText: event.sourceText,
        rawTargetText: event.targetText,
        revision: event.revision,
    }
    entry.checkpoint = checkpoint
    entry.pending = null
    const id = pairKey(event.sourceText, event.targetText)
    if (!entry.acceptedPairs.has(id)) entry.acceptedPairs.set(id, checkpoint)
}

function acceptedPairCheckpoint(entry, sourceText, targetText) {
    return entry.acceptedPairs.get(pairKey(sourceText, targetText))
}

function recordPending(entry, event, provenance) {
    const lineageCheckpoint = entry.pending?.lineageCheckpoint ?? entry.checkpoint
    entry.pending = {
        provenance,
        revision: event.revision,
        sourceText: event.sourceText,
        targetText: event.targetText,
        lineageCheckpoint,
    }
}

// English moving away from what a translation was accepted against is what creates review
// debt. Recording it when the source changes, rather than when a marker is finally written,
// is what lets a later mechanical marker be recognized as materializing this debt instead of
// being mistaken for somebody asking for review.
function recordSourceTriggeredDebt(state, event) {
    for (const entry of state.byKey.get(event.key) ?? []) {
        if (!entry.checkpoint) continue
        if (entry.pending) continue
        if (sameText(entry.checkpoint.sourceText, event.sourceText)) continue
        recordPending(
            entry,
            {
                revision: event.revision,
                sourceText: event.sourceText,
                targetText: entry.checkpoint.targetText,
            },
            PENDING_PROVENANCE.SOURCE_CHANGE
        )
    }
}

// The bot writes '? existing target' onto a translation whose English already moved. The
// payload is unchanged and no new decision was made, so this must not be read as a human
// review request: that would give the marker its own provenance and block the source-return
// clearing the entry is still entitled to.
function isMarkerMaterialization(entry, event) {
    if (event.kind !== HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED) return false
    if (!entry.checkpoint) return false
    if (sameText(entry.checkpoint.sourceText, event.sourceText)) return false
    return sameText(entry.checkpoint.targetText, event.targetText)
}

export function applyEvents(state, events) {
    const applied = []
    for (const originalEvent of events) {
        if (originalEvent.locale === undefined) {
            if (originalEvent.kind === HISTORY_EVENT.SOURCE_CHANGED) {
                recordSourceTriggeredDebt(state, originalEvent)
            }
            applied.push(originalEvent)
            continue
        }
        let event = originalEvent
        const entry = entryFor(state, event.locale, event.key)

        if (isMarkerMaterialization(entry, event)) {
            if (!entry.pending) recordPending(entry, event, PENDING_PROVENANCE.SOURCE_CHANGE)
            applied.push({ ...event, kind: HISTORY_EVENT.REVIEW_MARKER_MATERIALIZED })
            continue
        }

        const sourceReturnCheckpoint =
            event.kind === HISTORY_EVENT.KEEP &&
            entry.pending?.provenance === PENDING_PROVENANCE.SOURCE_CHANGE
                ? acceptedPairCheckpoint(entry, event.sourceText, event.targetText)
                : undefined
        if (sourceReturnCheckpoint) {
            event = { ...event, kind: HISTORY_EVENT.SOURCE_RETURN_CLEARED }
            entry.checkpoint = sourceReturnCheckpoint
            entry.pending = null
            applied.push(event)
            continue
        }

        if (ACCEPTING_EVENTS.has(event.kind)) {
            recordAcceptance(entry, event)
            applied.push(event)
            continue
        }
        if (PENDING_EVENTS.has(event.kind)) {
            if (event.kind === HISTORY_EVENT.SOURCE_TRIGGERED_PENDING) {
                recordPending(entry, event, PENDING_PROVENANCE.SOURCE_CHANGE)
            } else if (event.kind === HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED) {
                recordPending(entry, event, PENDING_PROVENANCE.EXPLICIT_REQUEST)
            } else {
                recordPending(entry, event, PENDING_PROVENANCE.ORPHAN)
            }
            applied.push(event)
            continue
        }
        if (event.kind === HISTORY_EVENT.PENDING_EDIT) {
            // The marker keeps whatever asked for it. Only the canonical text moves, so a
            // later source return is judged against the text that is actually stored now.
            const provenance =
                entry.pending?.provenance ??
                (entry.checkpoint ? PENDING_PROVENANCE.MANUAL_EDIT : PENDING_PROVENANCE.ORPHAN)
            recordPending(entry, event, provenance)
            applied.push(event)
            continue
        }
        if (
            event.kind === HISTORY_EVENT.TRANSLATION_WITHDRAWN ||
            event.kind === HISTORY_EVENT.TARGET_REMOVED
        ) {
            entry.checkpoint = null
            entry.pending = null
        }
        applied.push(event)
    }
    return applied
}

export function applyBaseline(state, snapshot, revision) {
    for (const [localeId, locale] of snapshot.locales) {
        for (const [key, value] of locale.targets) {
            const sourceText = snapshot.source.get(key)
            if (value.kind === TARGET_VALUE_KIND.ACCEPTED && sourceText !== undefined) {
                recordAcceptance(entryFor(state, localeId, key), {
                    sourceText,
                    targetText: value.targetText,
                    revision,
                })
                continue
            }
            if (value.kind !== TARGET_VALUE_KIND.PENDING) continue
            recordPending(
                entryFor(state, localeId, key),
                { revision, sourceText, targetText: value.targetText },
                PENDING_PROVENANCE.BASELINE
            )
        }
    }
    return state
}

export function acceptedPairExists(entry, sourceText, targetText) {
    if (!entry) return false
    return entry.acceptedPairs.has(pairKey(sourceText, targetText))
}

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseTargetValue, TARGET_VALUE_KIND } from '../src/shared/i18n-values.js'
import { createGitAdapter } from './i18n-git.mjs'
import {
    acceptedPairExists,
    analyzeTransition,
    entryId,
    applyBaseline,
    applyEvents,
    createHistoryState,
    HISTORY_EVENT,
    normalize,
} from './i18n-history-events.mjs'

// The audited migration commit on main. Every accepted checkpoint is reconstructed from
// here forward; pre-baseline events exist for research but create no review debt. Rewriting
// repository history requires a new audit and a new constant, never a guessed replacement.
export const I18N_HISTORY_BASELINE = 'c0d5814991976169076c12f893a3a68e0d4a12be'

export const I18N_LOCALE_DIR = 'apps/desktop/src/renderer/src/i18n'

const SOURCE_LOCALE = 'en'

export const HISTORY_UNAVAILABLE = Object.freeze({
    BASELINE_MISSING: 'baseline-missing',
    BASELINE_NOT_ANCESTOR: 'baseline-not-ancestor',
    BASELINE_NOT_FIRST_PARENT: 'baseline-not-first-parent',
    HISTORY_INCOMPLETE: 'history-incomplete',
    LEGACY_GRAFTS: 'legacy-grafts',
    REVISION_MISSING: 'revision-missing',
})

export class I18nHistoryUnavailableError extends Error {
    constructor(reason, detail, baseline) {
        super(
            `${detail}\n` +
                `Full i18n history through ${baseline} is required.\n` +
                'This checkout was not modified.\n' +
                'Fetch full history or rely on CI.\n' +
                'Use pnpm i18n:fill <locale> for history-independent scaffolding.'
        )
        this.name = 'I18nHistoryUnavailableError'
        this.reason = reason
        this.baseline = baseline
    }
}

export class I18nHistoryDataError extends Error {
    constructor(message, options) {
        super(message, options)
        this.name = 'I18nHistoryDataError'
    }
}

export class I18nHistoryStateError extends Error {
    constructor(message, { revision, locale, key } = {}) {
        super(message)
        this.name = 'I18nHistoryStateError'
        this.revision = revision
        this.locale = locale
        this.key = key
    }
}

function localeIdFromPath(path) {
    return basename(path, '.json')
}

function parseBundle(text, label) {
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new I18nHistoryDataError(`Failed to parse ${label} during i18n history analysis`, {
            cause: error,
        })
    }
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformedValueType(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

function flattenForHistory(bundle, label, prefix = '', flat = Object.create(null)) {
    if (!isPlainObject(bundle)) {
        throw new I18nHistoryDataError(`${label} must contain a JSON object`)
    }

    for (const [key, value] of Object.entries(bundle)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') {
            flat[path] = value
            continue
        }
        if (isPlainObject(value)) {
            flattenForHistory(value, label, path, flat)
            continue
        }
        throw new I18nHistoryDataError(
            `${label} key '${path}' has unsupported ${malformedValueType(value)} content`
        )
    }
    return flat
}

function parseTargets(flat, label) {
    const targets = new Map()
    for (const [key, raw] of Object.entries(flat)) {
        try {
            targets.set(key, parseTargetValue(raw))
        } catch (error) {
            throw new I18nHistoryDataError(
                `Malformed target ${label} key '${key}': ${error.message}`,
                { cause: error }
            )
        }
    }
    return targets
}

function createBundleCache(counters) {
    const flats = new Map()
    const targets = new Map()
    return {
        flat(id, text, label) {
            let flat = flats.get(id)
            if (flat) return flat
            flat = flattenForHistory(parseBundle(text, label), label)
            counters.bundleParses += 1
            flats.set(id, flat)
            return flat
        },
        targets(id, flat, label) {
            let parsed = targets.get(id)
            if (parsed) return parsed
            parsed = parseTargets(flat, label)
            targets.set(id, parsed)
            return parsed
        },
    }
}

function buildSnapshot(revision, blobPaths, contents, cache) {
    const snapshot = { revision, source: new Map(), locales: new Map() }
    for (const [path, id] of blobPaths) {
        if (!path.endsWith('.json')) continue
        const localeId = localeIdFromPath(path)
        const text = contents.get(id)
        if (text === undefined) throw new Error(`Missing blob ${id} for ${path}`)
        const flat = cache.flat(id, text, `${localeId}.json@${revision}`)

        if (localeId === SOURCE_LOCALE) {
            for (const [key, value] of Object.entries(flat)) snapshot.source.set(key, value)
            continue
        }
        // Parsed target values keep their payloads as exact slices of the stored string, so
        // the raw text is still reachable without carrying a second copy of every bundle.
        snapshot.locales.set(localeId, {
            targets: cache.targets(id, flat, `${localeId}.json@${revision}`),
        })
    }
    return snapshot
}

export function snapshotFromBundles(revision, bundles) {
    const snapshot = { revision, source: new Map(), locales: new Map() }
    const entries = bundles instanceof Map ? bundles.entries() : Object.entries(bundles)
    for (const [localeId, bundle] of entries) {
        const label = `${localeId}.json@${revision}`
        const flat = flattenForHistory(bundle, label)
        if (localeId === SOURCE_LOCALE) {
            for (const [key, value] of Object.entries(flat)) snapshot.source.set(key, value)
            continue
        }
        snapshot.locales.set(localeId, { targets: parseTargets(flat, label) })
    }
    return snapshot
}

function assertSnapshotIntegrity(snapshot) {
    for (const [localeId, locale] of snapshot.locales) {
        for (const [key, value] of locale.targets) {
            if (value.kind !== TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) continue
            if (value.sourceText === snapshot.source.get(key)) continue
            throw new I18nHistoryStateError(
                `Scaffold '${localeId}' key '${key}' does not match current English at ${snapshot.revision}.`,
                { revision: snapshot.revision, locale: localeId, key }
            )
        }
    }
}

function assertHistoryAvailable(git, baseline, revision) {
    const head = git.resolveRevision(revision)
    if (!head) {
        throw new I18nHistoryUnavailableError(
            HISTORY_UNAVAILABLE.REVISION_MISSING,
            `Revision ${revision} could not be resolved.`,
            baseline
        )
    }
    if (!git.resolveRevision(baseline)) {
        const shallow = git.isShallow()
        throw new I18nHistoryUnavailableError(
            HISTORY_UNAVAILABLE.BASELINE_MISSING,
            shallow
                ? `Baseline ${baseline} is absent from this shallow checkout.`
                : `Baseline ${baseline} is not present in this repository.`,
            baseline
        )
    }
    if (git.hasLegacyGrafts()) {
        throw new I18nHistoryUnavailableError(
            HISTORY_UNAVAILABLE.LEGACY_GRAFTS,
            'Legacy Git grafts are active and cannot be used for authoritative i18n history.',
            baseline
        )
    }

    const firstParentChain = git.firstParentChain(head)
    if (firstParentChain.includes(baseline)) return head

    if (git.isShallow()) {
        throw new I18nHistoryUnavailableError(
            HISTORY_UNAVAILABLE.HISTORY_INCOMPLETE,
            `The first-parent path from ${revision} stops before baseline ${baseline}.`,
            baseline
        )
    }

    const baselineIsAncestor = git.isAncestor(baseline, head)
    throw new I18nHistoryUnavailableError(
        baselineIsAncestor
            ? HISTORY_UNAVAILABLE.BASELINE_NOT_FIRST_PARENT
            : HISTORY_UNAVAILABLE.BASELINE_NOT_ANCESTOR,
        baselineIsAncestor
            ? `Baseline ${baseline} is not on ${revision}'s first-parent chain.`
            : `Baseline ${baseline} is not an ancestor of ${revision}.`,
        baseline
    )
}

export function describeHistoryAvailability(options = {}) {
    const baseline = options.baseline ?? I18N_HISTORY_BASELINE
    const git = options.git ?? createGitAdapter({ cwd: options.cwd })
    try {
        const head = assertHistoryAvailable(git, baseline, options.revision ?? 'HEAD')
        return { available: true, baseline, revision: head }
    } catch (error) {
        if (!(error instanceof I18nHistoryUnavailableError)) throw error
        return { available: false, baseline, reason: error.reason, message: error.message }
    }
}

function loadSnapshots(git, revisions, localeDir, cache) {
    const blobPathsByRevision = revisions.map((revision) => [
        revision,
        git.treeBlobs(revision, localeDir),
    ])
    const wanted = new Set()
    for (const [, blobPaths] of blobPathsByRevision) {
        for (const id of blobPaths.values()) wanted.add(id)
    }
    const contents = git.readBlobs([...wanted])
    return blobPathsByRevision.map(([revision, blobPaths]) =>
        buildSnapshot(revision, blobPaths, contents, cache)
    )
}

function assertPendingLineage(snapshot, state) {
    for (const [localeId, locale] of snapshot.locales) {
        for (const [key, value] of locale.targets) {
            if (value.kind !== TARGET_VALUE_KIND.PENDING) continue
            const entry = state.entries.get(entryId(localeId, key))
            if (entry?.pending?.lineageCheckpoint) continue
            throw new I18nHistoryStateError(
                `Pending '${localeId}' key '${key}' has no accepted lineage at ${snapshot.revision}.`,
                { revision: snapshot.revision, locale: localeId, key }
            )
        }
    }
}

export function analyzeCommittedHistory(options = {}) {
    const baseline = options.baseline ?? I18N_HISTORY_BASELINE
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const git = options.git ?? createGitAdapter({ cwd: options.cwd })
    const head = assertHistoryAvailable(git, baseline, options.revision ?? 'HEAD')

    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const revisions = [baseline, ...git.firstParentRevisions(baseline, head, localeDir)]
    const snapshots = loadSnapshots(git, revisions, localeDir, cache)
    for (const snapshot of snapshots) assertSnapshotIntegrity(snapshot)

    const state = applyBaseline(createHistoryState(), snapshots[0], baseline)
    assertPendingLineage(snapshots[0], state)
    const events = []
    for (let index = 1; index < snapshots.length; index += 1) {
        const transition = analyzeTransition(
            snapshots[index - 1],
            snapshots[index],
            snapshots[index].revision
        )
        const applied = applyEvents(state, transition)
        assertPendingLineage(snapshots[index], state)
        events.push(...applied)
    }

    return {
        baseline,
        revision: head,
        revisions,
        snapshot: snapshots[snapshots.length - 1],
        state,
        events,
        committedEvents: events,
        stats: {
            revisions: revisions.length,
            gitCalls: git.counters?.gitCalls,
            blobLoads: git.counters?.blobLoads,
            bundleParses: counters.bundleParses,
        },
    }
}

function cloneState(state) {
    const copy = createHistoryState()
    for (const [id, entry] of state.entries) {
        copy.entries.set(id, {
            locale: entry.locale,
            key: entry.key,
            checkpoint: entry.checkpoint,
            pending: entry.pending,
            acceptedPairs: new Map(entry.acceptedPairs),
        })
    }
    return copy
}

export function workingTreeSnapshot(cwd, localeDir = I18N_LOCALE_DIR) {
    const directory = join(cwd, localeDir)
    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const blobPaths = new Map()
    const contents = new Map()
    for (const file of readdirSync(directory)) {
        if (!file.endsWith('.json')) continue
        const path = `${localeDir}/${file}`
        blobPaths.set(path, path)
        contents.set(path, readFileSync(join(directory, file), 'utf8'))
    }
    return buildSnapshot('working-tree', blobPaths, contents, cache)
}

export function stagedSnapshot(git, localeDir = I18N_LOCALE_DIR) {
    const { entries, conflicted } = git.indexBlobs(localeDir)
    if (conflicted.length > 0) {
        throw new Error(`Unresolved merge conflict in ${conflicted.join(', ')}`)
    }
    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const contents = git.readBlobs([...new Set(entries.values())])
    return buildSnapshot('staged', entries, contents, cache)
}

// Committed history through HEAD plus one candidate tree, evaluated as a single further
// transition. Sync and pre-commit both need this so an uncommitted Keep is read as a Keep
// instead of being overwritten with the marker it just removed.
function reduceProspective(history, snapshot, validateScaffolds) {
    if (validateScaffolds) assertSnapshotIntegrity(snapshot)
    const transition = analyzeTransition(history.snapshot, snapshot, snapshot.revision)
    const state = cloneState(history.state)
    const prospectiveEvents = applyEvents(state, transition)
    assertPendingLineage(snapshot, state)
    const committedEvents = history.committedEvents ?? history.events
    return {
        ...history,
        snapshot,
        state,
        events: [...committedEvents, ...prospectiveEvents],
        committedEvents,
        prospectiveEvents,
        prospective: true,
    }
}

export function analyzeProspective(history, snapshot) {
    return reduceProspective(history, snapshot, true)
}

// Sync accepts stale and obsolete scaffolds as repair input. Marker syntax and Pending
// lineage remain strict, and the completed plan is reanalyzed with full validation.
export function analyzeRepairableProspective(history, snapshot) {
    return reduceProspective(history, snapshot, false)
}

export function analyzeWorkingTree(options = {}) {
    const history = options.history ?? analyzeCommittedHistory(options)
    return analyzeProspective(
        history,
        workingTreeSnapshot(options.cwd ?? process.cwd(), options.localeDir)
    )
}

export function analyzeStaged(options = {}) {
    const git = options.git ?? createGitAdapter({ cwd: options.cwd })
    const history = options.history ?? analyzeCommittedHistory({ ...options, git })
    return analyzeProspective(history, stagedSnapshot(git, options.localeDir))
}

function entryState(value) {
    if (!value) return 'absent'
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return 'accepted'
    if (value.kind === TARGET_VALUE_KIND.PENDING) return 'pending'
    if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) return 'scaffold'
    return 'absent'
}

// Everything Stage 7 and Stage 8 need to decide an action, without either of them having to
// reread Git: current text, the checkpoint it was accepted against, why a marker is there,
// and whether this exact pair was ever accepted before.
export function summarizeHistory(history) {
    const { snapshot, state } = history
    const locales = new Map()
    for (const [localeId, locale] of snapshot.locales) {
        const entries = new Map()
        let accepted = 0
        let pending = 0
        for (const [key, value] of locale.targets) {
            const entry = state.entries.get(entryId(localeId, key))
            const sourceText = snapshot.source.get(key)
            const canonicalTarget =
                value.kind === TARGET_VALUE_KIND.ACCEPTED ||
                value.kind === TARGET_VALUE_KIND.PENDING
                    ? value.targetText
                    : undefined
            const status = entryState(value)
            if (status === 'accepted') accepted += 1
            if (status === 'pending') pending += 1

            entries.set(key, {
                locale: localeId,
                key,
                state: status,
                sourceText,
                canonicalTarget,
                checkpoint: entry?.checkpoint ?? null,
                lineageCheckpoint: entry?.pending?.lineageCheckpoint ?? null,
                pendingProvenance: entry?.pending?.provenance ?? null,
                hasAcceptedLineage:
                    status === 'pending'
                        ? Boolean(entry?.pending?.lineageCheckpoint)
                        : Boolean(entry?.checkpoint),
                sourceMatchesCheckpoint: Boolean(
                    entry?.checkpoint && sameSource(entry.checkpoint.sourceText, sourceText)
                ),
                acceptedPairSeen: acceptedPairExists(entry, sourceText, canonicalTarget),
            })
        }
        locales.set(localeId, { id: localeId, accepted, pending, entries })
    }
    return { baseline: history.baseline, revision: history.revision, locales }
}

function sameSource(left, right) {
    if (left === undefined || right === undefined) return false
    return normalize(left) === normalize(right)
}

export function explicitReviewRequests(history) {
    return history.events.filter((event) => event.kind === HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED)
}

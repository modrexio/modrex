import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
    parseTargetValue,
    TARGET_VALUE_KIND,
    type TargetValue,
} from '../src/shared/i18n-values.mts'
import { createGitAdapter, GitBlobDecodeError } from './i18n-git.mts'
import { errorMessage } from './i18n-io.mts'
import {
    acceptedPairExists,
    analyzeTransition,
    entryId,
    applyBaseline,
    applyEvents,
    applyEvidenceGaps,
    cloneHistoryState,
    createHistoryState,
    HISTORY_EVENT,
    normalize,
    PENDING_PROVENANCE,
    type HistorySnapshot,
    type HistoryState,
    type HistoryEvent,
    type EvidenceGap,
    type Checkpoint,
    type HistoryEntry,
    type TargetEvent,
} from './i18n-history-events.mts'

type Adapter = ReturnType<typeof createGitAdapter>
export type HistoryGit = Pick<
    Adapter,
    | 'resolveRevision'
    | 'isShallow'
    | 'isAncestor'
    | 'hasLegacyGrafts'
    | 'firstParentChain'
    | 'firstParentRevisions'
    | 'treeBlobs'
    | 'readBlobs'
    | 'indexBlobs'
> &
    Partial<Pick<Adapter, 'counters' | 'treesAtRevisions' | 'readBlobObservations'>>
export type HistoryOptions = {
    cwd?: string
    baseline?: string
    localeDir?: string
    revision?: string
    localeId?: string
    git?: HistoryGit
    history?: HistoryAnalysis
}
export type HistoryAnalysis = {
    baseline: string
    revision: string
    revisions: string[]
    snapshot: HistorySnapshot
    state: HistoryState
    events: HistoryEvent[]
    committedEvents: HistoryEvent[]
    prospectiveEvents?: HistoryEvent[]
    prospective?: boolean
    gaps: EvidenceGap[]
    stats: {
        revisions: number
        gitCalls: number | undefined
        blobLoads: number | undefined
        bundleParses: number
    }
}
type BundleObservation =
    { kind: 'parsed'; value: unknown } | { kind: 'invalid-json' | 'invalid-utf8'; cause: unknown }
export type EffectiveState = 'accepted' | 'review' | 'missing'
type SummaryBase = {
    locale: string
    key: string
    state: 'absent' | 'accepted' | 'pending' | 'scaffold'
    gapIds: string[]
    lastProvenCheckpoint: Checkpoint | null
    sourceText: string | undefined
    lineageCheckpoint: Checkpoint | null
    pendingProvenance: NonNullable<HistoryEntry['pending']>['provenance'] | null
    effectiveProvenance: NonNullable<HistoryEntry['pending']>['provenance'] | 'history-gap' | null
    hasAcceptedLineage: boolean
    sourceMatchesCheckpoint: boolean
    acceptedPairSeen: boolean
}
export type EffectiveEntry = SummaryBase &
    (
        | {
              effectiveState: 'accepted'
              checkpoint: Checkpoint & { sourceText: string }
              canonicalTarget: string
          }
        | { effectiveState: 'review'; checkpoint: Checkpoint | null; canonicalTarget: string }
        | { effectiveState: 'missing'; checkpoint: Checkpoint | null; canonicalTarget: undefined }
    )
export type LocaleHistorySummary = {
    id: string
    accepted: number
    pending: number
    effective: Record<EffectiveState, number>
    entries: Map<string, EffectiveEntry>
}
export type HistorySummary = {
    baseline: string
    revision: string
    locales: Map<string, LocaleHistorySummary>
    gaps: EvidenceGap[]
}

// Acceptance reconstruction starts at the audited baseline. Pre-baseline events create no
// review debt. Rewriting repository history requires a new audit, never a guessed baseline.
export const I18N_HISTORY_BASELINE = 'da1040c9f04d7e004d5cd1fee3af15fabaa80b7e'

export const I18N_LOCALE_DIR = 'apps/desktop/src/renderer/src/i18n'

const SOURCE_LOCALE = 'en'
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const HISTORY_UNAVAILABLE = Object.freeze({
    BASELINE_MISSING: 'baseline-missing',
    BASELINE_NOT_ANCESTOR: 'baseline-not-ancestor',
    BASELINE_NOT_FIRST_PARENT: 'baseline-not-first-parent',
    HISTORY_INCOMPLETE: 'history-incomplete',
    LEGACY_GRAFTS: 'legacy-grafts',
    REVISION_MISSING: 'revision-missing',
} as const)

export class I18nHistoryUnavailableError extends Error {
    reason: (typeof HISTORY_UNAVAILABLE)[keyof typeof HISTORY_UNAVAILABLE]
    baseline: string
    constructor(
        reason: (typeof HISTORY_UNAVAILABLE)[keyof typeof HISTORY_UNAVAILABLE],
        detail: string,
        baseline: string
    ) {
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
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'I18nHistoryDataError'
    }
}

export class I18nHistoryStateError extends Error {
    revision: string | undefined
    locale: string | undefined
    key: string | undefined
    constructor(
        message: string,
        { revision, locale, key }: { revision?: string; locale?: string; key?: string } = {}
    ) {
        super(message)
        this.name = 'I18nHistoryStateError'
        this.revision = revision
        this.locale = locale
        this.key = key
    }
}

function localeIdFromPath(path: string) {
    return basename(path, '.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformedValueType(value: unknown) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

function flattenForHistory(
    bundle: unknown,
    label: string,
    prefix = '',
    flat: Record<string, string> = Object.create(null)
): Record<string, string> {
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

function parseTargets(flat: Record<string, string>, label: string) {
    const targets = new Map<string, TargetValue>()
    for (const [key, raw] of Object.entries(flat)) {
        try {
            targets.set(key, parseTargetValue(raw))
        } catch (error) {
            throw new I18nHistoryDataError(
                `Malformed target ${label} key '${key}': ${errorMessage(error)}`,
                { cause: error }
            )
        }
    }
    return targets
}

function createBundleCache(counters: { bundleParses: number }) {
    const syntax = new Map<string, BundleObservation>()
    const flats = new Map<string, Record<string, string>>()
    const targets = new Map<string, Map<string, TargetValue>>()
    return {
        parse(id: string, text: string | GitBlobDecodeError): BundleObservation {
            if (syntax.has(id)) return syntax.get(id)!
            if (text instanceof GitBlobDecodeError) {
                const result: BundleObservation = { kind: 'invalid-utf8', cause: text }
                syntax.set(id, result)
                return result
            }
            let result: BundleObservation
            try {
                result = { kind: 'parsed', value: JSON.parse(text) }
            } catch (error) {
                result = { kind: 'invalid-json', cause: error }
            }
            counters.bundleParses += 1
            syntax.set(id, result)
            return result
        },
        flat(id: string, bundle: unknown, label: string) {
            if (!flats.has(id)) flats.set(id, flattenForHistory(bundle, label))
            return flats.get(id)!
        },
        targets(id: string, flat: Record<string, string>, label: string) {
            if (!targets.has(id)) targets.set(id, parseTargets(flat, label))
            return targets.get(id)!
        },
    }
}

function buildSnapshot(
    revision: string,
    blobPaths: Map<string, string>,
    contents: ReadonlyMap<string, string | GitBlobDecodeError>,
    cache: ReturnType<typeof createBundleCache>
): HistorySnapshot {
    const snapshot: HistorySnapshot = {
        revision,
        source: new Map(),
        locales: new Map(),
        gaps: [],
    }
    let sourceSeen = false
    for (const [path, id] of blobPaths) {
        if (!path.endsWith('.json')) continue
        const localeId = localeIdFromPath(path)
        if (localeId === SOURCE_LOCALE) sourceSeen = true
        const text = contents.get(id)
        if (text === undefined) throw new Error('Missing blob ' + id + ' for ' + path)
        const parsed = cache.parse(id, text)
        if (parsed.kind !== 'parsed') {
            snapshot.gaps.push({
                id: revision + ':' + path + ':' + id,
                locale: localeId,
                revision,
                path,
                blob: id,
                kind: parsed.kind,
                message:
                    'Failed to parse ' +
                    localeId +
                    '.json@' +
                    revision +
                    ' during i18n history analysis',
                cause: parsed.cause,
            })
            continue
        }
        const flat = cache.flat(id, parsed.value, localeId + '.json@' + revision)
        if (localeId === SOURCE_LOCALE) {
            for (const [key, value] of Object.entries(flat)) snapshot.source.set(key, value)
            continue
        }
        snapshot.locales.set(localeId, {
            targets: cache.targets(id, flat, localeId + '.json@' + revision),
        })
    }
    if (!sourceSeen)
        snapshot.gaps.push({
            id: revision + ':en:missing',
            locale: 'en',
            revision,
            kind: 'missing-source',
            message: 'English source locale is missing at ' + revision,
        })
    return snapshot
}

function assertReadableSnapshot(snapshot: HistorySnapshot) {
    if (snapshot.gaps.length === 0) return snapshot
    const gap = snapshot.gaps[0]!
    if (gap.cause instanceof GitBlobDecodeError) throw gap.cause
    throw new I18nHistoryDataError(gap.message, { cause: gap.cause })
}

export function snapshotFromBundles(
    revision: string,
    bundles: Map<string, unknown> | Record<string, unknown>
): HistorySnapshot {
    const snapshot: HistorySnapshot = {
        revision,
        source: new Map(),
        locales: new Map(),
        gaps: [],
    }
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

function assertSnapshotIntegrity(snapshot: HistorySnapshot) {
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

function assertHistoryAvailable(git: HistoryGit, baseline: string, revision: string) {
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

export function describeHistoryAvailability(options: HistoryOptions = {}) {
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

function loadSnapshots(
    git: HistoryGit,
    revisions: string[],
    localeDir: string,
    cache: ReturnType<typeof createBundleCache>,
    localeId?: string
) {
    const blobPathsByRevision = git.treesAtRevisions
        ? [...git.treesAtRevisions(revisions, localeDir)]
        : revisions.map((revision): [string, Map<string, string>] => [
              revision,
              git.treeBlobs(revision, localeDir),
          ])
    if (localeId !== undefined) {
        for (const [, paths] of blobPathsByRevision) {
            for (const path of paths.keys()) {
                if (
                    path !== localeDir + '/en.json' &&
                    path !== localeDir + '/' + localeId + '.json'
                )
                    paths.delete(path)
            }
        }
    }
    const wanted = new Set<string>()
    for (const [, blobPaths] of blobPathsByRevision)
        for (const id of blobPaths.values()) wanted.add(id)
    const contents = git.readBlobObservations
        ? git.readBlobObservations([...wanted])
        : git.readBlobs([...wanted])
    return blobPathsByRevision.map(([revision, blobPaths]) =>
        buildSnapshot(revision, blobPaths, contents, cache)
    )
}

function assertPendingLineage(snapshot: HistorySnapshot, state: HistoryState) {
    for (const [localeId, locale] of snapshot.locales) {
        for (const [key, value] of locale.targets) {
            if (value.kind !== TARGET_VALUE_KIND.PENDING) continue
            const entry = state.entries.get(entryId(localeId, key))
            if (entry?.pending?.lineageCheckpoint || (entry && entry.gapIds.size > 0)) continue
            throw new I18nHistoryStateError(
                `Pending '${localeId}' key '${key}' has no accepted lineage at ${snapshot.revision}.`,
                { revision: snapshot.revision, locale: localeId, key }
            )
        }
    }
}

export function analyzeCommittedHistory(options: HistoryOptions = {}): HistoryAnalysis {
    const baseline = options.baseline ?? I18N_HISTORY_BASELINE
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const git = options.git ?? createGitAdapter({ cwd: options.cwd })
    const head = assertHistoryAvailable(git, baseline, options.revision ?? 'HEAD')

    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const revisions = [baseline, ...git.firstParentRevisions(baseline, head, localeDir)]
    const snapshots = loadSnapshots(git, revisions, localeDir, cache, options.localeId)

    // Historical scaffolds can quote superseded English between a source commit and bot repair.
    assertReadableSnapshot(snapshots[0]!)
    assertReadableSnapshot(snapshots[snapshots.length - 1]!)
    const state = applyBaseline(createHistoryState(), snapshots[0]!, baseline)
    assertPendingLineage(snapshots[0]!, state)
    const events: HistoryEvent[] = []
    for (let index = 1; index < snapshots.length; index += 1) {
        applyEvidenceGaps(state, snapshots[index - 1]!, snapshots[index]!)
        const transition = analyzeTransition(
            snapshots[index - 1]!,
            snapshots[index]!,
            snapshots[index]!.revision
        )
        const applied = applyEvents(state, transition)
        assertPendingLineage(snapshots[index]!, state)
        events.push(...applied)
    }

    return {
        baseline,
        revision: head,
        revisions,
        snapshot: { ...snapshots[snapshots.length - 1]!, revision: head },
        gaps: snapshots.flatMap((snapshot) => snapshot.gaps),
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

export function workingTreeSnapshot(cwd: string, localeDir = I18N_LOCALE_DIR, localeId?: string) {
    const directory = join(cwd, localeDir)
    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const blobPaths = new Map<string, string>()
    const contents = new Map<string, string>()
    for (const file of readdirSync(directory)) {
        if (!file.endsWith('.json')) continue
        if (localeId !== undefined && file !== 'en.json' && file !== localeId + '.json') continue
        const path = `${localeDir}/${file}`
        blobPaths.set(path, path)
        const bytes = readFileSync(join(directory, file))
        try {
            contents.set(path, UTF8_DECODER.decode(bytes))
        } catch (error) {
            throw new I18nHistoryDataError('Invalid UTF-8 locale file at ' + path, { cause: error })
        }
    }
    return assertReadableSnapshot(buildSnapshot('working-tree', blobPaths, contents, cache))
}

export function stagedSnapshot(git: HistoryGit, localeDir = I18N_LOCALE_DIR) {
    const { entries, conflicted } = git.indexBlobs(localeDir)
    if (conflicted.length > 0) {
        throw new Error(`Unresolved merge conflict in ${conflicted.join(', ')}`)
    }
    const counters = { bundleParses: 0 }
    const cache = createBundleCache(counters)
    const contents = git.readBlobs([...new Set(entries.values())])
    return assertReadableSnapshot(buildSnapshot('staged', entries, contents, cache))
}

// Committed history through HEAD plus one candidate tree, evaluated as a single further
// transition. Sync and pre-commit both need this so an uncommitted Keep is read as a Keep
// instead of being overwritten with the marker it just removed.
function reduceProspective(
    history: HistoryAnalysis,
    snapshot: HistorySnapshot,
    validateScaffolds: boolean
): HistoryAnalysis {
    if (validateScaffolds) assertSnapshotIntegrity(snapshot)
    const transition = analyzeTransition(history.snapshot, snapshot, snapshot.revision)
    const state = cloneHistoryState(history.state)
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

export function analyzeProspective(history: HistoryAnalysis, snapshot: HistorySnapshot) {
    return reduceProspective(history, snapshot, true)
}

// Sync accepts stale and obsolete scaffolds as repair input. Marker syntax and Pending
// lineage remain strict, and the completed plan is reanalyzed with full validation.
export function analyzeRepairableProspective(history: HistoryAnalysis, snapshot: HistorySnapshot) {
    return reduceProspective(history, snapshot, false)
}

export function analyzeWorkingTree(options: HistoryOptions = {}) {
    const history = options.history ?? analyzeCommittedHistory(options)
    return analyzeProspective(
        history,
        workingTreeSnapshot(options.cwd ?? process.cwd(), options.localeDir, options.localeId)
    )
}

export function analyzeStaged(options: HistoryOptions = {}) {
    const git = options.git ?? createGitAdapter({ cwd: options.cwd })
    const history = options.history ?? analyzeCommittedHistory({ ...options, git })
    return analyzeProspective(history, stagedSnapshot(git, options.localeDir))
}

function entryState(value: TargetValue | undefined): SummaryBase['state'] {
    if (!value) return 'absent'
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return 'accepted'
    if (value.kind === TARGET_VALUE_KIND.PENDING) return 'pending'
    if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) return 'scaffold'
    return 'absent'
}

// The three states the translation workflow actually has. They are derived from Git
// evidence, not from whichever marker happens to be stored: a translation whose English
// moved needs Review whether or not the bot has written its '? ' yet, and an English
// scaffold is Missing whether or not it still quotes the current English.
export const EFFECTIVE_STATE = Object.freeze({
    ACCEPTED: 'accepted',
    REVIEW: 'review',
    MISSING: 'missing',
})

function effectiveStateOf(
    storedState: SummaryBase['state'],
    sourceMatchesCheckpoint: boolean
): EffectiveState {
    if (storedState === 'pending') return EFFECTIVE_STATE.REVIEW
    if (storedState !== 'accepted') return EFFECTIVE_STATE.MISSING
    return sourceMatchesCheckpoint ? EFFECTIVE_STATE.ACCEPTED : EFFECTIVE_STATE.REVIEW
}

// Consumers share the same acceptance evidence so review and sync cannot disagree about
// the checkpoint, pending provenance or whether the current pair was accepted.
export function summarizeHistory(history: HistoryAnalysis): HistorySummary {
    const { snapshot, state } = history
    const locales = new Map<string, LocaleHistorySummary>()
    for (const [localeId, locale] of snapshot.locales) {
        const entries = new Map<string, EffectiveEntry>()
        let accepted = 0
        let pending = 0
        const effective = { accepted: 0, review: 0, missing: 0 }
        // Keys English declares but this locale has not stored are Missing, so the summary
        // has to cover the source key set rather than only what the bundle happens to hold.
        const keys = new Set([...snapshot.source.keys(), ...locale.targets.keys()])
        for (const key of keys) {
            const value = locale.targets.get(key)
            const entry = state.entries.get(entryId(localeId, key))
            const sourceText = snapshot.source.get(key)
            const canonicalTarget =
                value?.kind === TARGET_VALUE_KIND.ACCEPTED ||
                value?.kind === TARGET_VALUE_KIND.PENDING
                    ? value.targetText
                    : undefined
            const status = entryState(value)
            if (status === 'accepted') accepted += 1
            if (status === 'pending') pending += 1

            const sourceMatchesCheckpoint = Boolean(
                entry?.checkpoint &&
                entry.gapIds.size === 0 &&
                sameSource(entry.checkpoint.sourceText, sourceText) &&
                canonicalTarget !== undefined &&
                normalize(entry.checkpoint.targetText) === normalize(canonicalTarget)
            )
            const effectiveState = effectiveStateOf(status, sourceMatchesCheckpoint)
            effective[effectiveState] += 1

            const result: SummaryBase & {
                effectiveState: EffectiveState
                canonicalTarget: string | undefined
                checkpoint: Checkpoint | null
            } = {
                locale: localeId,
                key,
                state: status,
                effectiveState,
                effectiveProvenance:
                    effectiveState === EFFECTIVE_STATE.REVIEW
                        ? entry && entry.gapIds.size > 0
                            ? 'history-gap'
                            : (entry?.pending?.provenance ?? PENDING_PROVENANCE.SOURCE_CHANGE)
                        : null,
                sourceText,
                canonicalTarget,
                gapIds: [...(entry?.gapIds ?? [])],
                lastProvenCheckpoint: entry?.lastProvenCheckpoint ?? null,
                checkpoint: entry?.checkpoint ?? null,
                lineageCheckpoint: entry?.pending?.lineageCheckpoint ?? null,
                pendingProvenance: entry?.pending?.provenance ?? null,
                hasAcceptedLineage:
                    status === 'pending'
                        ? Boolean(entry?.pending?.lineageCheckpoint)
                        : Boolean(entry?.checkpoint),
                sourceMatchesCheckpoint,
                acceptedPairSeen: acceptedPairExists(entry, sourceText, canonicalTarget),
            }
            if (effectiveState === EFFECTIVE_STATE.ACCEPTED) {
                entries.set(key, {
                    ...result,
                    effectiveState,
                    canonicalTarget: canonicalTarget!,
                    checkpoint: entry!.checkpoint! as Checkpoint & { sourceText: string },
                })
            } else if (effectiveState === EFFECTIVE_STATE.REVIEW) {
                entries.set(key, { ...result, effectiveState, canonicalTarget: canonicalTarget! })
            } else {
                entries.set(key, { ...result, effectiveState, canonicalTarget: undefined })
            }
        }
        locales.set(localeId, { id: localeId, accepted, pending, effective, entries })
    }
    return {
        baseline: history.baseline,
        revision: history.revision,
        locales,
        gaps: history.gaps,
    }
}

function sameSource(left: string | undefined, right: string | undefined) {
    if (left === undefined || right === undefined) return false
    return normalize(left) === normalize(right)
}

export function explicitReviewRequests(history: HistoryAnalysis) {
    return history.events.filter(
        (event): event is TargetEvent & { kind: typeof HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED } =>
            event.kind === HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED
    )
}

export function canDeferPlaceholderMismatch(entry: EffectiveEntry | undefined) {
    return entry?.effectiveState === EFFECTIVE_STATE.REVIEW && entry.gapIds.length === 0
}

// An evidence gap cannot authorize marker writes or excuse translation validation failures.
export function assertHistoryDecisionEvidence(history: HistoryAnalysis) {
    for (const locale of summarizeHistory(history).locales.values()) {
        for (const entry of locale.entries.values()) {
            if (entry.gapIds.length === 0 || entry.canonicalTarget === undefined) continue
            const gaps = history.gaps.filter((gap) => entry.gapIds.includes(gap.id))
            throw new I18nHistoryDataError(
                "Insufficient historical evidence for '" +
                    entry.locale +
                    "' key '" +
                    entry.key +
                    "'. History-dependent decisions are blocked. " +
                    gaps
                        .map((gap) => gap.locale + '.json@' + gap.revision + ': ' + gap.kind)
                        .join(', ')
            )
        }
    }
}

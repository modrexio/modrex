import type { CliIO } from './i18n-io.mts'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    PENDING_PREFIX,
    TARGET_VALUE_KIND,
    UNTRANSLATED_PREFIX,
    type TargetValue,
} from '../src/shared/i18n-values.mts'
import {
    buildOrderedLocale,
    inspectSourceBundle,
    inspectTranslationBundle,
} from './i18n-current.mts'
import { serializeLocale, writeSerializedFileAtomically, type LocaleBundle } from './i18n-files.mts'
import {
    analyzeCommittedHistory,
    analyzeProspective,
    analyzeRepairableProspective,
    EFFECTIVE_STATE,
    I18N_HISTORY_BASELINE,
    I18N_LOCALE_DIR,
    snapshotFromBundles,
    summarizeHistory,
    canDeferPlaceholderMismatch,
    assertHistoryDecisionEvidence,
    workingTreeSnapshot,
    type HistoryAnalysis,
    type HistorySummary,
    type HistoryOptions,
} from './i18n-history.mts'
import { PENDING_PROVENANCE } from './i18n-history-events.mts'
import { inspectLocales, type Inspection } from './i18n-inspection.mts'

type SyncKind = (typeof SYNC_OPERATION)[keyof typeof SYNC_OPERATION]
export type SyncOperation = { kind: SyncKind; locale: string; key: string }
type ObsoleteTarget = {
    locale: string
    key: string
    state: TargetValue['kind']
    targetText: string
}
export type SyncLocalePlan = { id: string; bundle: LocaleBundle; operations: SyncOperation[] }
export type SyncPlan = { sourceBundle: LocaleBundle; locales: SyncLocalePlan[] }
export type SyncWrite = SyncLocalePlan & { path: string; serialized: string; changed: boolean }
export type SyncResult = {
    plan: SyncPlan
    writes: SyncWrite[]
    written: string[]
    finalHistory: HistoryAnalysis
}
type Write = (path: string, serialized: string) => boolean | void
export type SyncOptions = HistoryOptions & CliIO & { i18nDir?: string; write?: Write }

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

export const SYNC_OPERATION = Object.freeze({
    SCAFFOLD_ADDED: 'scaffold-added',
    SCAFFOLD_REFRESHED: 'scaffold-refreshed',
    SCAFFOLD_REMOVED: 'scaffold-removed',
    REVIEW_REQUESTED: 'review-requested',
    SOURCE_RETURN_CLEARED: 'source-return-cleared',
} as const)

export class I18nSyncPlanError extends Error {
    issues: ObsoleteTarget[]
    constructor(issues: ObsoleteTarget[]) {
        super(
            [
                'i18n:sync cannot delete target-language content:',
                ...issues.map(formatIssue),
                'Remove or migrate each target value explicitly, then rerun pnpm i18n:sync.',
            ].join('\n')
        )
        this.name = 'I18nSyncPlanError'
        this.issues = issues
    }
}

export class I18nSyncValidationError extends Error {
    errors: string[]
    constructor(errors: string[]) {
        super(['i18n:sync validation failed:', ...errors.map((error) => `  ${error}`)].join('\n'))
        this.name = 'I18nSyncValidationError'
        this.errors = errors
    }
}

function formatIssue(issue: ObsoleteTarget) {
    return `  ${issue.locale} ${issue.key} (${issue.state}): ${JSON.stringify(issue.targetText)}`
}

function operation(kind: SyncKind, locale: string, key: string): SyncOperation {
    return { kind, locale, key }
}

function targetTextForStorage(value: TargetValue) {
    if (value.kind === TARGET_VALUE_KIND.PENDING) return `${PENDING_PREFIX}${value.targetText}`
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return value.targetText
    return undefined
}

function planLocale(
    history: HistoryAnalysis,
    summary: HistorySummary,
    localeId: string,
    sourceKeys: string[]
) {
    const locale = history.snapshot.locales.get(localeId)!
    const entries = summary.locales.get(localeId)?.entries
    const sourceKeySet = new Set(sourceKeys)
    const strings: Record<string, string> = Object.create(null)
    const operations: SyncOperation[] = []
    const obsoleteTargets: ObsoleteTarget[] = []

    for (const [key, value] of locale.targets) {
        if (sourceKeySet.has(key)) continue
        if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
            operations.push(operation(SYNC_OPERATION.SCAFFOLD_REMOVED, localeId, key))
            continue
        }
        const targetText = targetTextForStorage(value)
        if (targetText === undefined) continue
        obsoleteTargets.push({ locale: localeId, key, state: value.kind, targetText })
    }

    for (const key of sourceKeys) {
        const sourceText = history.snapshot.source.get(key)
        const value = locale.targets.get(key) ?? { kind: TARGET_VALUE_KIND.ABSENT }
        if (value.kind === TARGET_VALUE_KIND.ABSENT) {
            strings[key] = `${UNTRANSLATED_PREFIX}${sourceText}`
            operations.push(operation(SYNC_OPERATION.SCAFFOLD_ADDED, localeId, key))
            continue
        }
        if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) {
            strings[key] = `${UNTRANSLATED_PREFIX}${sourceText}`
            if (value.sourceText !== sourceText) {
                operations.push(operation(SYNC_OPERATION.SCAFFOLD_REFRESHED, localeId, key))
            }
            continue
        }

        const entry = entries?.get(key)
        if (!entry) throw new Error(`History summary is missing '${localeId}' key '${key}'`)
        if (value.kind === TARGET_VALUE_KIND.ACCEPTED) {
            if (entry.sourceMatchesCheckpoint) {
                strings[key] = value.targetText
                continue
            }
            strings[key] = `${PENDING_PREFIX}${value.targetText}`
            operations.push(operation(SYNC_OPERATION.REVIEW_REQUESTED, localeId, key))
            continue
        }

        const sourceReturnEligible =
            entry.pendingProvenance === PENDING_PROVENANCE.SOURCE_CHANGE && entry.acceptedPairSeen
        if (sourceReturnEligible) {
            strings[key] = value.targetText
            operations.push(operation(SYNC_OPERATION.SOURCE_RETURN_CLEARED, localeId, key))
            continue
        }
        strings[key] = `${PENDING_PREFIX}${value.targetText}`
    }

    return { localeId, strings, operations, obsoleteTargets }
}

export function planI18nSync({
    history,
    sourceBundle,
}: {
    history: HistoryAnalysis
    sourceBundle: LocaleBundle
}): SyncPlan {
    assertHistoryDecisionEvidence(history)
    const summary = summarizeHistory(history)
    const sourceKeys = [...history.snapshot.source.keys()]
    const localeIds = [...history.snapshot.locales.keys()].sort()
    const localePlans: SyncLocalePlan[] = []
    const obsoleteTargets: ObsoleteTarget[] = []

    for (const localeId of localeIds) {
        const localePlan = planLocale(history, summary, localeId, sourceKeys)
        obsoleteTargets.push(...localePlan.obsoleteTargets)
        localePlans.push({
            id: localeId,
            bundle: buildOrderedLocale(sourceBundle, localePlan.strings),
            operations: localePlan.operations,
        })
    }

    if (obsoleteTargets.length > 0) throw new I18nSyncPlanError(obsoleteTargets)
    return { sourceBundle, locales: localePlans }
}

function currentInputErrors(inspection: Inspection, history: HistoryAnalysis) {
    const summary = summarizeHistory(history)
    const errors: string[] = []
    for (const locale of inspection.locales) {
        for (const issue of locale.issues) {
            if (issue.type === 'stale-scaffold' || issue.type === 'unknown-key') continue
            if (issue.type === 'placeholder') {
                // Placeholders that disagree with English are an error against a translation
                // still accepted, and expected debt against one whose English has moved.
                const entry = summary.locales.get(locale.id)?.entries.get(issue.key)
                if (canDeferPlaceholderMismatch(entry)) continue
            }
            const key = issue.key ? ` key '${issue.key}'` : ''
            errors.push(`'${locale.id}'${key}: ${issue.detail ?? issue.type}`)
        }
    }
    return errors
}

function validateCurrentInput(inspection: Inspection, history: HistoryAnalysis) {
    const errors = currentInputErrors(inspection, history)
    if (errors.length > 0) throw new I18nSyncValidationError(errors)
}

export function validatePlannedBundles(plan: SyncPlan) {
    const source = inspectSourceBundle(plan.sourceBundle, 'en')
    const errors = [...source.errors]
    for (const locale of plan.locales) {
        const inspection = inspectTranslationBundle(
            locale.id,
            locale.bundle,
            source.strings,
            source.keys
        )
        errors.push(...inspection.errors)
        const absent = source.keys.filter(
            (key) => inspection.targetValues[key]?.kind === TARGET_VALUE_KIND.ABSENT
        )
        if (absent.length > 0) {
            errors.push(`'${locale.id}' remains structurally incomplete`)
        }
    }
    if (errors.length > 0) throw new I18nSyncValidationError(errors)
}

function plannedSnapshot(plan: SyncPlan) {
    return snapshotFromBundles(
        'sync-plan',
        new Map<string, unknown>([
            ['en', plan.sourceBundle],
            ...plan.locales.map((locale): [string, LocaleBundle] => [locale.id, locale.bundle]),
        ])
    )
}

function validateAuthoritativePlan(committedHistory: HistoryAnalysis, plan: SyncPlan) {
    const finalHistory = analyzeProspective(committedHistory, plannedSnapshot(plan))
    const summary = summarizeHistory(finalHistory)
    const errors = []
    for (const locale of summary.locales.values()) {
        for (const entry of locale.entries.values()) {
            if (entry.state === 'accepted' && entry.effectiveState === EFFECTIVE_STATE.REVIEW) {
                errors.push(`'${entry.locale}' key '${entry.key}' still requires Review`)
            }
            const clearablePending =
                entry.state === 'pending' &&
                entry.pendingProvenance === PENDING_PROVENANCE.SOURCE_CHANGE &&
                entry.acceptedPairSeen
            if (clearablePending) {
                errors.push(`'${entry.locale}' key '${entry.key}' still has a clearable marker`)
            }
        }
    }
    if (errors.length > 0) throw new I18nSyncValidationError(errors)
    return finalHistory
}

function prepareWrites(plan: SyncPlan, i18nDir: string): SyncWrite[] {
    return plan.locales.map((locale) => {
        const path = resolve(i18nDir, `${locale.id}.json`)
        const serialized = serializeLocale(locale.bundle)
        return {
            ...locale,
            path,
            serialized,
            changed: readFileSync(path, 'utf8') !== serialized,
        }
    })
}

export function applySyncWrites(writes: SyncWrite[], write: Write = writeSerializedFileAtomically) {
    const written: string[] = []
    for (const file of writes) {
        if (!file.changed) continue
        const replaced = write(file.path, file.serialized)
        if (replaced !== false) written.push(file.id)
    }
    return written
}

export function synchronizeI18n(options: SyncOptions = {}): SyncResult {
    const cwd = options.cwd ?? REPOSITORY_ROOT
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const i18nDir = options.i18nDir ?? resolve(cwd, localeDir)
    const inspection = inspectLocales(i18nDir)
    if (inspection.sourceErrors.length > 0) {
        throw new I18nSyncValidationError(inspection.sourceErrors)
    }

    const committedHistory = analyzeCommittedHistory({
        cwd,
        baseline: options.baseline ?? I18N_HISTORY_BASELINE,
        localeDir,
        revision: options.revision,
    })
    const workingSnapshot = workingTreeSnapshot(cwd, localeDir)
    const workingHistory = analyzeRepairableProspective(committedHistory, workingSnapshot)
    assertHistoryDecisionEvidence(workingHistory)
    validateCurrentInput(inspection, workingHistory)
    const plan = planI18nSync({
        history: workingHistory,
        sourceBundle: inspection.sourceBundle as LocaleBundle,
    })
    validatePlannedBundles(plan)
    const finalHistory = validateAuthoritativePlan(committedHistory, plan)
    const writes = prepareWrites(plan, i18nDir)
    const written = applySyncWrites(writes, options.write)
    return { plan, writes, written, finalHistory }
}

function countOperations(locale: Pick<SyncLocalePlan, 'operations'>, kind: SyncKind) {
    return locale.operations.filter((item) => item.kind === kind).length
}

export function formatSyncSummary(result: SyncResult) {
    const lines = ['i18n:sync']
    for (const file of result.writes) {
        lines.push(
            `  ${file.id}: ${file.changed ? 'changed' : 'unchanged'}; ` +
                `${countOperations(file, SYNC_OPERATION.SCAFFOLD_ADDED)} scaffolds added, ` +
                `${countOperations(file, SYNC_OPERATION.SCAFFOLD_REFRESHED)} refreshed, ` +
                `${countOperations(file, SYNC_OPERATION.SCAFFOLD_REMOVED)} removed, ` +
                `${countOperations(file, SYNC_OPERATION.REVIEW_REQUESTED)} review requests added, ` +
                `${countOperations(file, SYNC_OPERATION.SOURCE_RETURN_CLEARED)} source-return markers cleared`
        )
    }
    lines.push(
        result.written.length === 0
            ? 'No locale files changed.'
            : `${result.written.length} locale file(s) changed.`
    )
    lines.push(
        'Target-language content edits: 0',
        'No target-language text was created, rewritten, or accepted.'
    )
    if (result.written.length > 0) lines.push('Inspect and stage the deterministic locale changes.')
    return lines.join('\n')
}

export function runI18nSync(
    args: string[],
    { stdout = process.stdout, stderr = process.stderr, ...options }: SyncOptions = {}
) {
    if (args.length > 0) {
        stderr.write('Usage: pnpm i18n:sync\n')
        return 2
    }
    try {
        const result = synchronizeI18n(options)
        stdout.write(`${formatSyncSummary(result)}\n`)
        return 0
    } catch (error) {
        stderr.write(`i18n:sync: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
    }
}

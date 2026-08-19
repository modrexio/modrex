import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    PENDING_PREFIX,
    TARGET_VALUE_KIND,
    UNTRANSLATED_PREFIX,
} from '../src/shared/i18n-values.js'
import {
    buildOrderedLocale,
    inspectSourceBundle,
    inspectTranslationBundle,
} from './i18n-current.mjs'
import { serializeLocale, writeSerializedFileAtomically } from './i18n-files.mjs'
import {
    analyzeCommittedHistory,
    analyzeProspective,
    analyzeRepairableProspective,
    I18N_HISTORY_BASELINE,
    I18N_LOCALE_DIR,
    snapshotFromBundles,
    summarizeHistory,
    workingTreeSnapshot,
} from './i18n-history.mjs'
import { PENDING_PROVENANCE } from './i18n-history-events.mjs'
import { inspectLocales } from './i18n-inspection.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

export const SYNC_OPERATION = Object.freeze({
    SCAFFOLD_ADDED: 'scaffold-added',
    SCAFFOLD_REFRESHED: 'scaffold-refreshed',
    SCAFFOLD_REMOVED: 'scaffold-removed',
    REVIEW_REQUESTED: 'review-requested',
    SOURCE_RETURN_CLEARED: 'source-return-cleared',
})

export class I18nSyncPlanError extends Error {
    constructor(issues) {
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
    constructor(errors) {
        super(['i18n:sync validation failed:', ...errors.map((error) => `  ${error}`)].join('\n'))
        this.name = 'I18nSyncValidationError'
        this.errors = errors
    }
}

function formatIssue(issue) {
    return `  ${issue.locale} ${issue.key} (${issue.state}): ${JSON.stringify(issue.targetText)}`
}

function operation(kind, locale, key) {
    return { kind, locale, key }
}

function targetTextForStorage(value) {
    if (value.kind === TARGET_VALUE_KIND.PENDING) return `${PENDING_PREFIX}${value.targetText}`
    if (value.kind === TARGET_VALUE_KIND.ACCEPTED) return value.targetText
    return undefined
}

function planLocale(history, summary, localeId, sourceKeys) {
    const locale = history.snapshot.locales.get(localeId)
    const entries = summary.locales.get(localeId)?.entries
    const sourceKeySet = new Set(sourceKeys)
    const strings = Object.create(null)
    const operations = []
    const obsoleteTargets = []

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

export function planI18nSync({ history, sourceBundle }) {
    const summary = summarizeHistory(history)
    const sourceKeys = [...history.snapshot.source.keys()]
    const localeIds = [...history.snapshot.locales.keys()].sort()
    const localePlans = []
    const obsoleteTargets = []

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

function currentInputErrors(inspection, history) {
    const summary = summarizeHistory(history)
    const errors = []
    for (const locale of inspection.locales) {
        for (const issue of locale.issues) {
            if (issue.type === 'stale-scaffold' || issue.type === 'unknown-key') continue
            if (issue.type === 'placeholder') {
                const entry = summary.locales.get(locale.id)?.entries.get(issue.key)
                if (entry?.state === 'accepted' && !entry.sourceMatchesCheckpoint) continue
            }
            const key = issue.key ? ` key '${issue.key}'` : ''
            errors.push(`'${locale.id}'${key}: ${issue.detail ?? issue.type}`)
        }
    }
    return errors
}

function validateCurrentInput(inspection, history) {
    const errors = currentInputErrors(inspection, history)
    if (errors.length > 0) throw new I18nSyncValidationError(errors)
}

export function validatePlannedBundles(plan) {
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

function plannedSnapshot(plan) {
    return snapshotFromBundles(
        'sync-plan',
        new Map([
            ['en', plan.sourceBundle],
            ...plan.locales.map((locale) => [locale.id, locale.bundle]),
        ])
    )
}

function validateAuthoritativePlan(committedHistory, plan) {
    const finalHistory = analyzeProspective(committedHistory, plannedSnapshot(plan))
    const summary = summarizeHistory(finalHistory)
    const errors = []
    for (const locale of summary.locales.values()) {
        for (const entry of locale.entries.values()) {
            if (entry.state === 'accepted' && !entry.sourceMatchesCheckpoint) {
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

function prepareWrites(plan, i18nDir) {
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

export function applySyncWrites(writes, write = writeSerializedFileAtomically) {
    const written = []
    for (const file of writes) {
        if (!file.changed) continue
        const replaced = write(file.path, file.serialized)
        if (replaced !== false) written.push(file.id)
    }
    return written
}

export function synchronizeI18n(options = {}) {
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
    validateCurrentInput(inspection, workingHistory)
    const plan = planI18nSync({ history: workingHistory, sourceBundle: inspection.sourceBundle })
    validatePlannedBundles(plan)
    const finalHistory = validateAuthoritativePlan(committedHistory, plan)
    const writes = prepareWrites(plan, i18nDir)
    const written = applySyncWrites(writes, options.write)
    return { plan, writes, written, finalHistory }
}

function countOperations(locale, kind) {
    return locale.operations.filter((item) => item.kind === kind).length
}

export function formatSyncSummary(result) {
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
    args,
    { stdout = process.stdout, stderr = process.stderr, ...options } = {}
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
        stderr.write(`i18n:sync: ${error.message}\n`)
        return 1
    }
}

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serializeLocale } from './i18n-files.mjs'
import { formatTargetValue, TARGET_VALUE_KIND } from '../src/shared/i18n-values.js'
import { HISTORY_EVENT } from './i18n-history-events.mjs'
import {
    analyzeCommittedHistory,
    analyzeRepairableProspective,
    I18N_HISTORY_BASELINE,
    I18N_LOCALE_DIR,
    stagedSnapshot,
    workingTreeSnapshot,
} from './i18n-history.mjs'
import { createGitAdapter } from './i18n-git.mjs'
import { planI18nSync, validatePlannedBundles } from './i18n-sync.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function setPath(root, dottedKey, value) {
    const parts = dottedKey.split('.')
    let cursor = root
    for (const part of parts.slice(0, -1)) {
        cursor[part] ??= {}
        cursor = cursor[part]
    }
    cursor[parts.at(-1)] = value
}

function snapshotBundles(snapshot) {
    const sourceBundle = {}
    for (const [key, value] of snapshot.source) setPath(sourceBundle, key, value)

    const locales = new Map()
    for (const [localeId, locale] of snapshot.locales) {
        const bundle = {}
        for (const [key, value] of locale.targets) {
            const stored = formatTargetValue(value)
            if (stored !== undefined) setPath(bundle, key, stored)
        }
        locales.set(localeId, bundle)
    }
    return { sourceBundle, locales }
}

function relevantPath(path, localeDir) {
    const normalized = path.replaceAll('\\', '/')
    return (
        normalized === `${localeDir}/en.json` ||
        (normalized.startsWith(`${localeDir}/`) && normalized.endsWith('.json'))
    )
}

function comparePlan(plan, current) {
    const operations = plan.locales.flatMap((locale) => locale.operations)
    const differences = []
    for (const locale of plan.locales) {
        const expected = serializeLocale(locale.bundle)
        const actual = serializeLocale(current.locales.get(locale.id) ?? {})
        if (expected !== actual) {
            differences.push(
                ...(locale.operations.length > 0
                    ? locale.operations
                    : [{ locale: locale.id, key: '<locale>', kind: 'serialization-drift' }])
            )
        }
    }
    return { differences, operations }
}

const TARGET_EDIT_EVENTS = new Set([
    HISTORY_EVENT.FIRST_TRANSLATION,
    HISTORY_EVENT.ACCEPTED_EDIT,
    HISTORY_EVENT.EDIT_FROM_PENDING,
    HISTORY_EVENT.PENDING_EDIT,
])

export function summarizeWorkflow({ history, baseSnapshot, currentSnapshot }) {
    const summary = {
        targetContentEdits: [],
        keeps: [],
        newlyPending: [],
        scaffoldsAdded: [],
        scaffoldsRefreshed: [],
        scaffoldsRemoved: [],
        sourceReturnClears: [],
    }
    for (const event of history.prospectiveEvents ?? []) {
        const item = { locale: event.locale, key: event.key }
        if (TARGET_EDIT_EVENTS.has(event.kind)) summary.targetContentEdits.push(item)
        if (event.kind === HISTORY_EVENT.KEEP) summary.keeps.push(item)
        if (
            event.kind === HISTORY_EVENT.SOURCE_TRIGGERED_PENDING ||
            event.kind === HISTORY_EVENT.EXPLICIT_REVIEW_REQUESTED
        ) {
            summary.newlyPending.push(item)
        }
        if (event.kind === HISTORY_EVENT.SCAFFOLD_CREATED) summary.scaffoldsAdded.push(item)
        if (event.kind === HISTORY_EVENT.SCAFFOLD_REFRESHED) summary.scaffoldsRefreshed.push(item)
        if (event.kind === HISTORY_EVENT.SOURCE_RETURN_CLEARED)
            summary.sourceReturnClears.push(item)
    }
    const baseLocales = baseSnapshot?.locales ?? new Map()
    for (const [localeId, baseLocale] of baseLocales) {
        const currentLocale = currentSnapshot.locales.get(localeId)
        for (const [key, value] of baseLocale.targets) {
            if (value.kind !== TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) continue
            if (!currentLocale?.targets.has(key))
                summary.scaffoldsRemoved.push({ locale: localeId, key })
        }
    }
    return summary
}

export function formatWorkflowSummary(summary) {
    const labels = [
        ['targetContentEdits', 'target-content edits'],
        ['keeps', 'accepted unchanged / Keeps'],
        ['newlyPending', 'newly Pending reviews'],
        ['scaffoldsAdded', 'scaffolds added'],
        ['scaffoldsRefreshed', 'scaffolds refreshed'],
        ['scaffoldsRemoved', 'scaffolds removed'],
        ['sourceReturnClears', 'source-return clears'],
    ]
    return labels
        .filter(([key]) => summary[key].length > 0)
        .map(([key, label]) => `${label}: ${summary[key].length}`)
        .join(', ')
}

export function summarizeEnforcementOperations(operations) {
    const counts = new Map()
    for (const operation of operations)
        counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1)
    return [...counts.entries()].map(([kind, count]) => `${kind}: ${count}`).join(', ')
}

export function stagedI18nPaths({ cwd = process.cwd(), localeDir = I18N_LOCALE_DIR, git } = {}) {
    const adapter = git ?? createGitAdapter({ cwd })
    return adapter.stagedChangedPaths().filter((path) => relevantPath(path, localeDir))
}

// Both gates need the same reconstruction: committed history, the candidate tree read as one
// further transition, and the synchronization plan that tree implies. They differ only in what
// they conclude from it, so the analysis is built once here and judged twice below.
function analyzeSnapshot({
    cwd = REPOSITORY_ROOT,
    localeDir = I18N_LOCALE_DIR,
    baseline = I18N_HISTORY_BASELINE,
    snapshot,
    git,
} = {}) {
    const adapter = git ?? createGitAdapter({ cwd })
    const committed = analyzeCommittedHistory({ cwd, localeDir, baseline, git: adapter })
    const currentSnapshot = snapshot ?? workingTreeSnapshot(cwd, localeDir)
    if (currentSnapshot.source.size === 0) {
        throw new Error('Staged/current English source locale is missing')
    }
    const missingLocales = [...committed.snapshot.locales.keys()].filter(
        (localeId) => !currentSnapshot.locales.has(localeId)
    )
    if (missingLocales.length > 0) {
        throw new Error(`Staged/current target locale is missing: ${missingLocales.join(', ')}`)
    }
    const prospective = analyzeRepairableProspective(committed, currentSnapshot)
    const { sourceBundle, locales } = snapshotBundles(currentSnapshot)

    // The plan is what the tree means once derived markers are resolved, so validating it is
    // what separates a real translation error from marker work the bot has not done yet. A
    // wrong placeholder against unchanged English stays accepted in the plan and fails here;
    // the same wrong placeholder after an English change becomes Review and does not.
    const plan = planI18nSync({ history: prospective, sourceBundle })
    validatePlannedBundles(plan)

    return {
        history: prospective,
        plan,
        comparison: comparePlan(plan, { sourceBundle, locales }),
        workflowSummary: summarizeWorkflow({
            history: prospective,
            baseSnapshot: committed.snapshot,
            currentSnapshot,
        }),
    }
}

// Is this tree valid translation data? A source-only change is, and so is a translation whose
// English moved before the bot wrote its marker. Reaching this return means the plan validated.
export function checkI18nSemantics(options = {}) {
    const analysis = analyzeSnapshot(options)
    return {
        pass: true,
        skipped: false,
        history: analysis.history,
        plan: analysis.plan,
        operations: [],
        allOperations: analysis.comparison.operations,
        unsynchronized: analysis.comparison.differences,
        workflowSummary: analysis.workflowSummary,
    }
}

// Has the bot caught up? Only the writer's own post-generation check and an explicit local
// run ask this. It must never gate a contributor's commit.
export function checkI18nSnapshot(options = {}) {
    const analysis = analyzeSnapshot(options)
    return {
        pass: analysis.comparison.differences.length === 0,
        skipped: false,
        history: analysis.history,
        plan: analysis.plan,
        operations: analysis.comparison.differences,
        allOperations: analysis.comparison.operations,
        workflowSummary: analysis.workflowSummary,
    }
}

export function checkStagedI18n(options = {}) {
    const cwd = options.cwd ?? REPOSITORY_ROOT
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const git = options.git ?? createGitAdapter({ cwd })
    if (stagedI18nPaths({ cwd, localeDir, git }).length === 0) {
        return { pass: true, skipped: true, operations: [], allOperations: [] }
    }
    return checkI18nSemantics({
        ...options,
        cwd,
        localeDir,
        git,
        snapshot: stagedSnapshot(git, localeDir),
    })
}

export function formatEnforcementFailure(result) {
    const lines = ['Derived i18n markers are not synchronized.', '']
    if (result.operations.length > 0) {
        lines.push('Planned operations:')
        for (const operation of result.operations) {
            lines.push(`  ${operation.locale} ${operation.key} (${operation.kind})`)
        }
        lines.push('')
    }
    lines.push('Run:', '  pnpm i18n:sync', '', 'Then stage the updated locale files.')
    return lines.join('\n')
}

const MODES = new Set(['--staged', '--synchronized'])

export function runI18nEnforcement(
    args,
    { stdout = process.stdout, stderr = process.stderr, ...options } = {}
) {
    if (args.length > 1 || (args.length === 1 && !MODES.has(args[0]))) {
        stderr.write('Usage: node scripts/i18n-enforcement.mjs [--staged|--synchronized]\n')
        return 2
    }
    const synchronized = args[0] === '--synchronized'
    const label = synchronized ? 'synchronization check' : 'semantic check'
    try {
        const result = synchronized
            ? checkI18nSnapshot(options)
            : args[0] === '--staged'
              ? checkStagedI18n(options)
              : checkI18nSemantics(options)
        if (result.skipped) {
            stdout.write(`i18n: ${label} skipped (no staged locale/source files).\n`)
            return 0
        }
        if (!result.pass) {
            stderr.write(`${formatEnforcementFailure(result)}\n`)
            return 1
        }
        const details = [
            result.allOperations.length ? summarizeEnforcementOperations(result.allOperations) : '',
            result.workflowSummary ? formatWorkflowSummary(result.workflowSummary) : '',
        ].filter(Boolean)
        stdout.write(`i18n: ${label} passed${details.length ? ` (${details.join('; ')})` : ''}.\n`)
        // Marker work the bot still owes is reported, never charged to this tree.
        if (result.unsynchronized?.length > 0) {
            stdout.write(
                `i18n: ${result.unsynchronized.length} derived marker update(s) pending; the translation-status workflow writes them.\n`
            )
        }
        return 0
    } catch (error) {
        stderr.write(`i18n: ${label}: ${error.message}\n`)
        return 1
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runI18nEnforcement(process.argv.slice(2))
}

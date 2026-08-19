import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
    parseTargetValue,
    placeholderContract,
    placeholderDifferences,
    PENDING_PREFIX,
    TARGET_VALUE_KIND,
} from '../src/shared/i18n-values.js'
import { inspectUnicode } from './i18n-diagnostics.mjs'
import { writeLocaleAtomically } from './i18n-files.mjs'
import {
    createSemanticStyles,
    detectCliCapabilities,
    renderPlaceholderText,
} from './i18n-presentation-cli.mjs'
import {
    analyzeCommittedHistory,
    analyzeRepairableProspective,
    I18nHistoryUnavailableError,
    I18N_HISTORY_BASELINE,
    I18N_LOCALE_DIR,
    summarizeHistory,
    workingTreeSnapshot,
} from './i18n-history.mjs'
import {
    I18N_DIR,
    inspectLocales,
    localeEnglishName,
    localeNativeName,
    SOURCE_LOCALE,
    validateLocaleId,
} from './i18n-inspection.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

export const REVIEW_ACTION = Object.freeze({
    EDIT: 'edit',
    KEEP: 'keep',
    SKIP: 'skip',
})

export class I18nReviewValidationError extends Error {
    constructor(errors) {
        super(['i18n:review validation failed:', ...errors.map((error) => `  ${error}`)].join('\n'))
        this.name = 'I18nReviewValidationError'
        this.errors = errors
    }
}

function formatSourceText(value, styles) {
    return value
        .split('\n')
        .map((line) => `  ${renderPlaceholderText(line, styles)}`)
        .join('\n')
}

function formatPlaceholderNames(names) {
    return names.map((name) => `{${name}}`).join(', ')
}

function placeholderStatus(sourceText, targetText) {
    const differences = placeholderDifferences(
        placeholderContract(sourceText),
        placeholderContract(targetText)
    )
    return {
        ...differences,
        compatible: differences.missing.length === 0 && differences.unexpected.length === 0,
    }
}

export function buildReviewCandidates(history, localeId) {
    const locale = summarizeHistory(history).locales.get(localeId)
    if (!locale) throw new Error(`Authoritative history has no target locale '${localeId}'`)

    const candidates = []
    for (const key of history.snapshot.source.keys()) {
        const entry = locale.entries.get(key)
        if (entry?.state !== 'pending') continue
        if (!entry.lineageCheckpoint) {
            throw new Error(`Pending '${localeId}' key '${key}' has no accepted lineage`)
        }

        const placeholders = placeholderStatus(entry.sourceText, entry.canonicalTarget)
        candidates.push({
            locale: localeId,
            key,
            lastAcceptedSourceText: entry.lineageCheckpoint.rawSourceText,
            lastAcceptedTargetText: entry.lineageCheckpoint.rawTargetText,
            checkpointRevision: entry.lineageCheckpoint.revision,
            currentSourceText: entry.sourceText,
            currentTargetText: entry.canonicalTarget,
            pendingProvenance: entry.pendingProvenance,
            placeholderCompatible: placeholders.compatible,
            missingPlaceholders: placeholders.missing,
            unexpectedPlaceholders: placeholders.unexpected,
        })
    }
    return candidates
}

export function reviewEditProblems(candidate, targetText) {
    if (targetText.trim().length === 0) return ['Target text must not be empty.']

    let parsed
    try {
        parsed = parseTargetValue(targetText)
    } catch (error) {
        return [`Invalid workflow marker syntax: ${error.message}`]
    }
    if (parsed.kind !== TARGET_VALUE_KIND.ACCEPTED) {
        return ['An edited target must not begin with the reserved "! " or "? " prefix.']
    }

    const differences = placeholderDifferences(
        placeholderContract(candidate.currentSourceText),
        parsed.placeholderContract
    )
    const problems = []
    if (differences.missing.length > 0) {
        problems.push(`Missing placeholder: ${formatPlaceholderNames(differences.missing)}`)
    }
    if (differences.unexpected.length > 0) {
        problems.push(`Unexpected placeholder: ${formatPlaceholderNames(differences.unexpected)}`)
    }
    for (const finding of inspectUnicode(targetText)) {
        if (finding.severity !== 'error') continue
        problems.push(
            `Unsafe Unicode: ${finding.codePoint ?? finding.description}${finding.name ? ` (${finding.name})` : ''}`
        )
    }
    return problems
}

export function applyReviewAction(candidate, action, editedTarget) {
    if (action === REVIEW_ACTION.SKIP) {
        return { changed: false, storedValue: `${PENDING_PREFIX}${candidate.currentTargetText}` }
    }
    if (action === REVIEW_ACTION.KEEP) {
        if (!candidate.placeholderCompatible) {
            throw new Error(
                'Keep is unavailable because the current target has incompatible placeholders'
            )
        }
        return { changed: true, storedValue: candidate.currentTargetText }
    }
    if (action !== REVIEW_ACTION.EDIT) throw new Error(`Unknown review action '${action}'`)

    const problems = reviewEditProblems(candidate, editedTarget)
    if (problems.length > 0) throw new I18nReviewValidationError(problems)
    return { changed: true, storedValue: editedTarget }
}

function targetLocale(inspection, localeId) {
    const locale = inspection.locales.find(({ id }) => id === localeId)
    if (!locale) {
        const available = inspection.locales.map(({ id }) => id).join(', ')
        throw new Error(`Unknown translation locale '${localeId}'. Available locales: ${available}`)
    }
    return locale
}

function isReviewSafeSyncDebt(locale, issue) {
    if (issue.type === 'stale-scaffold') return true
    if (issue.type !== 'unknown-key') return false
    return locale.targetValues[issue.key]?.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
}

function replaceTargetLeaf(bundle, targetKey, storedValue) {
    let replacements = 0

    function replace(value, prefix = '') {
        const result = {}
        for (const [key, child] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key
            if (typeof child === 'string') {
                const matchesTarget = path === targetKey
                result[key] = matchesTarget ? storedValue : child
                if (matchesTarget) replacements += 1
                continue
            }
            result[key] = replace(child, path)
        }
        return result
    }

    const updated = replace(bundle)
    if (replacements !== 1) {
        throw new Error(`Review target '${targetKey}' resolved to ${replacements} locale leaves`)
    }
    return updated
}

export function prepareI18nReview(options) {
    const cwd = options.cwd ?? REPOSITORY_ROOT
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const i18nDir = options.i18nDir ?? resolve(cwd, localeDir)
    const inspection = inspectLocales(i18nDir)
    if (inspection.sourceErrors.length > 0) {
        throw new I18nReviewValidationError(inspection.sourceErrors)
    }

    const locale = targetLocale(inspection, options.localeId)
    const blockingIssues = locale.issues.filter((issue) => !isReviewSafeSyncDebt(locale, issue))
    if (blockingIssues.length > 0) throw new I18nReviewValidationError(locale.errors)

    const committedHistory = analyzeCommittedHistory({
        cwd,
        baseline: options.baseline ?? I18N_HISTORY_BASELINE,
        localeDir,
        revision: options.revision,
    })
    const history = analyzeRepairableProspective(
        committedHistory,
        workingTreeSnapshot(cwd, localeDir)
    )
    return {
        candidates: buildReviewCandidates(history, options.localeId),
        history,
        inspection,
        locale,
        localePath: resolve(i18nDir, `${options.localeId}.json`),
    }
}

function formatCandidate(candidate, position, total, styles) {
    const status = candidate.placeholderCompatible
        ? 'compatible'
        : 'incompatible (runtime uses English)'
    return [
        `[${position}/${total}] ${candidate.key}`,
        '',
        'English at last accepted checkpoint:',
        formatSourceText(candidate.lastAcceptedSourceText, styles),
        '',
        'Current English:',
        formatSourceText(candidate.currentSourceText, styles),
        '',
        'Current target:',
        formatSourceText(candidate.currentTargetText, styles),
        '',
        `Placeholder status: ${status}`,
    ].join('\n')
}

async function promptAction(candidate, ask, stdout) {
    const choices = candidate.placeholderCompatible
        ? '[e] Edit, [k] Keep, [s] Skip'
        : '[e] Edit, [s] Skip (Keep unavailable: incompatible placeholders)'
    while (true) {
        stdout.write(`${choices}\n`)
        const answer = (await ask('> ')).trim().toLowerCase()
        if (answer === 'e' || answer === 'edit') return REVIEW_ACTION.EDIT
        if (answer === 's' || answer === 'skip' || answer === '') return REVIEW_ACTION.SKIP
        if (answer === 'k' || answer === 'keep') {
            if (candidate.placeholderCompatible) return REVIEW_ACTION.KEEP
            stdout.write('Keep is unavailable because runtime currently uses English.\n\n')
            continue
        }
        stdout.write('Choose Edit, Keep, or Skip.\n\n')
    }
}

async function promptEditedTarget(candidate, englishName, ask, stdout) {
    stdout.write(`\nNew ${englishName} target (Enter to skip):\n`)
    while (true) {
        const answer = await ask('> ')
        if (answer.trim().length === 0) return null
        const problems = reviewEditProblems(candidate, answer)
        if (problems.length === 0) return answer
        stdout.write(
            `\nInvalid target:\n  ${problems.join('\n  ')}\n\nEnter the target again, or press Enter to skip:\n`
        )
    }
}

function saveReviewedValue(review, bundle, candidate, storedValue, write) {
    const updatedBundle = replaceTargetLeaf(bundle, candidate.key, storedValue)
    write(review.localePath, updatedBundle)
    return updatedBundle
}

export async function reviewLocaleSession({
    ask,
    review,
    stdout = process.stdout,
    env = process.env,
    write = writeLocaleAtomically,
}) {
    const localeName = localeNativeName(review.locale.id)
    if (review.candidates.length === 0) {
        stdout.write(`${localeName} (${review.locale.id}): no translations need review.\n`)
        return { edited: 0, kept: 0, skipped: 0 }
    }

    stdout.write(
        `${localeName} (${review.locale.id}): ${review.candidates.length} review-pending translation(s)\nPath: ${relative(process.cwd(), review.localePath).replaceAll('\\\\', '/')}\n\nReview actions record your decision; they do not prove linguistic correctness.\nPress Ctrl+C to cancel.\n\n`
    )
    const counts = { edited: 0, kept: 0, skipped: 0 }
    let bundle = review.locale.bundle
    const englishName = localeEnglishName(review.locale.id)
    const styles = createSemanticStyles(detectCliCapabilities({ stdout, env }).color)

    const writeSummary = (label) => {
        const saved = counts.edited + counts.kept
        const remaining = review.candidates.length - saved - counts.skipped
        stdout.write(
            `${label}: ${counts.edited} edited, ${counts.kept} kept.\nSaved: ${saved}\nSkipped: ${counts.skipped}\nRemaining: ${remaining}\n`
        )
    }

    try {
        for (const [index, candidate] of review.candidates.entries()) {
            stdout.write(
                `${formatCandidate(candidate, index + 1, review.candidates.length, styles)}\n\n`
            )
            const action = await promptAction(candidate, ask, stdout)
            if (action === REVIEW_ACTION.SKIP) {
                counts.skipped += 1
                stdout.write('\nSkipped\n\n')
                continue
            }

            let editedTarget
            if (action === REVIEW_ACTION.EDIT) {
                editedTarget = await promptEditedTarget(candidate, englishName, ask, stdout)
                if (editedTarget === null) {
                    counts.skipped += 1
                    stdout.write('\nSkipped\n\n')
                    continue
                }
            }

            const result = applyReviewAction(candidate, action, editedTarget)
            bundle = saveReviewedValue(review, bundle, candidate, result.storedValue, write)
            counts[action === REVIEW_ACTION.EDIT ? 'edited' : 'kept'] += 1
            stdout.write('\nSaved\n\n')
        }
    } catch (error) {
        writeSummary('Review interrupted')
        throw error
    }

    writeSummary('Review complete')
    return counts
}

async function runSession(review, options) {
    if (options.ask) {
        return reviewLocaleSession({
            ask: options.ask,
            review,
            stdout: options.stdout,
            env: options.env,
            write: options.write,
        })
    }

    const input = createInterface({ input: options.stdin, output: options.stdout })
    try {
        return await reviewLocaleSession({
            ask: (question) => input.question(question),
            review,
            stdout: options.stdout,
            env: options.env,
            write: options.write,
        })
    } finally {
        input.close()
    }
}

export async function runI18nReview(
    args,
    {
        ask,
        cwd = REPOSITORY_ROOT,
        localeDir = I18N_LOCALE_DIR,
        i18nDir = resolve(cwd, localeDir),
        stdin = process.stdin,
        stdout = process.stdout,
        stderr = process.stderr,
        write = writeLocaleAtomically,
        ...historyOptions
    } = {}
) {
    if (args.length !== 1) {
        stderr.write('Usage: pnpm i18n:review <locale>\n')
        return 2
    }

    const localeId = args[0]
    try {
        validateLocaleId(localeId)
    } catch (error) {
        stderr.write(`i18n:review: ${error.message}\n`)
        return 2
    }
    if (localeId === SOURCE_LOCALE) {
        stderr.write(`Locale '${SOURCE_LOCALE}' is the English source, not a review target.\n`)
        return 2
    }
    if (!existsSync(resolve(i18nDir, `${localeId}.json`))) {
        stderr.write(`Locale '${localeId}' does not exist.\n`)
        return 2
    }

    try {
        const review = prepareI18nReview({
            ...historyOptions,
            cwd,
            i18nDir,
            localeDir,
            localeId,
        })
        await runSession(review, { ask, stdin, stdout, write })
        return 0
    } catch (error) {
        stderr.write(`i18n:review: ${error.message}\n`)
        if (error instanceof I18nHistoryUnavailableError) {
            stderr.write('Full i18n history through the audited baseline is required.\n')
        }
        return 1
    }
}

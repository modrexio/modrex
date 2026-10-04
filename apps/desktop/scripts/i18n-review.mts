import { errorMessage, type CliIO, type CliOutput } from './i18n-io.mts'
import type { LocaleBundle } from './i18n-files.mts'
import type { HistoryAnalysis, HistoryOptions } from './i18n-history.mts'
import type { HistorySnapshot } from './i18n-history-events.mts'
import { normalize } from './i18n-history-events.mts'
import type { Inspection } from './i18n-inspection.mts'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
    formatTargetValue,
    parseTargetValue,
    placeholderContract,
    placeholderDifferences,
    PENDING_PREFIX,
    TARGET_VALUE_KIND,
} from '../src/shared/i18n-values.mts'
import { inspectUnicode } from './i18n-diagnostics.mts'
import { writeLocaleAtomically } from './i18n-files.mts'
import {
    createSemanticStyles,
    detectCliCapabilities,
    renderPlaceholderText,
} from './i18n-presentation-cli.mts'
import { isMechanicalSyncDebt } from './i18n-current.mts'
import {
    analyzeCommittedHistory,
    analyzeRepairableProspective,
    EFFECTIVE_STATE,
    I18nHistoryUnavailableError,
    I18N_HISTORY_BASELINE,
    I18N_LOCALE_DIR,
    summarizeHistory,
    canDeferPlaceholderMismatch,
    workingTreeSnapshot,
} from './i18n-history.mts'
import {
    inspectLocales,
    localeEnglishName,
    localeNativeName,
    SOURCE_LOCALE,
    validateLocaleId,
} from './i18n-inspection.mts'

type Candidate = ReturnType<typeof buildReviewCandidates>[number]
type Review = ReturnType<typeof prepareI18nReview>
type Ask = (question: string) => Promise<string>
type ReviewWriter = (path: string, bundle: LocaleBundle) => unknown
type ReviewOptions = HistoryOptions &
    CliIO & { i18nDir?: string; ask?: Ask; stdin?: NodeJS.ReadableStream; write?: ReviewWriter }

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../../..')

export const REVIEW_ACTION = Object.freeze({
    EDIT: 'edit',
    KEEP: 'keep',
    SKIP: 'skip',
} as const)

export class I18nReviewValidationError extends Error {
    errors: string[]

    constructor(errors: string[]) {
        super(['i18n:review validation failed:', ...errors.map((error) => `  ${error}`)].join('\n'))
        this.name = 'I18nReviewValidationError'
        this.errors = errors
    }
}

function formatSourceText(value: string, styles: ReturnType<typeof createSemanticStyles>) {
    return value
        .split('\n')
        .map((line) => `  ${renderPlaceholderText(line, styles)}`)
        .join('\n')
}

function formatPlaceholderNames(names: string[]) {
    return names.map((name) => `{${name}}`).join(', ')
}

function placeholderStatus(sourceText: string, targetText: string) {
    const differences = placeholderDifferences(
        placeholderContract(sourceText),
        placeholderContract(targetText)
    )
    return {
        ...differences,
        compatible: differences.missing.length === 0 && differences.unexpected.length === 0,
    }
}

// Acceptance is evidence in Git, so what the committed tree holds decides whether a decision
// can be recorded at all. Reading that from the working tree instead would let an uncommitted
// marker make a Keep look real when committing it would produce an empty diff.
export function buildReviewCandidates(
    history: HistoryAnalysis,
    localeId: string,
    committedSnapshot: HistorySnapshot = history.snapshot
) {
    const locale = summarizeHistory(history).locales.get(localeId)
    if (!locale) throw new Error(`Authoritative history has no target locale '${localeId}'`)
    const committedTargets = committedSnapshot.locales.get(localeId)?.targets

    const candidates = []
    for (const key of history.snapshot.source.keys()) {
        const entry = locale.entries.get(key)
        // A translation whose English moved needs review whether or not the bot has written
        // its marker yet, so the review list is built from the effective state.
        if (entry?.effectiveState !== EFFECTIVE_STATE.REVIEW) continue
        if (!entry.lineageCheckpoint && entry.gapIds.length === 0) {
            throw new Error(`Review '${localeId}' key '${key}' has no accepted lineage`)
        }

        const checkpoint = entry.lineageCheckpoint ?? entry.lastProvenCheckpoint
        const placeholders = placeholderStatus(entry.sourceText!, entry.canonicalTarget)
        candidates.push({
            locale: localeId,
            key,
            lastAcceptedSourceText: checkpoint?.rawSourceText ?? null,
            lastAcceptedTargetText: checkpoint?.rawTargetText ?? null,
            checkpointRevision: checkpoint?.revision ?? null,
            currentSourceText: entry.sourceText!,
            currentTargetText: entry.canonicalTarget,
            pendingProvenance: entry.effectiveProvenance,
            committedValue: committedTargets?.has(key)
                ? formatTargetValue(committedTargets.get(key)!)
                : undefined,
            evidenceIncomplete: entry.gapIds.length > 0,
            materialized: committedTargets?.get(key)?.kind === TARGET_VALUE_KIND.PENDING,
            placeholderCompatible: placeholders.compatible,
            missingPlaceholders: placeholders.missing,
            unexpectedPlaceholders: placeholders.unexpected,
        })
    }
    return candidates
}

function acceptanceRecordingInstruction(candidate: Candidate) {
    if (candidate.evidenceIncomplete)
        return 'First commit an explicit review marker for this key, then review it again.'
    return 'Run pnpm i18n:sync and commit the review marker first.'
}

// i18n-review.test.mjs enforces normalized edits and committed marker removal.
function wouldRecordAcceptance(candidate: Candidate, storedValue: string) {
    if (candidate.committedValue === undefined) return true
    return normalize(storedValue) !== normalize(candidate.committedValue)
}

export function reviewEditProblems(candidate: Candidate, targetText: string) {
    if (targetText.trim().length === 0) return ['Target text must not be empty.']

    let parsed
    try {
        parsed = parseTargetValue(targetText)
    } catch (error) {
        return [`Invalid workflow marker syntax: ${errorMessage(error)}`]
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
    if (!wouldRecordAcceptance(candidate, targetText)) {
        problems.push(
            'This is canonically identical to the committed value, so Git would record no acceptance. ' +
                acceptanceRecordingInstruction(candidate)
        )
    }
    return problems
}

export function applyReviewAction(
    candidate: Candidate,
    action: (typeof REVIEW_ACTION)[keyof typeof REVIEW_ACTION],
    editedTarget?: string
) {
    if (action === REVIEW_ACTION.SKIP) {
        return { changed: false, storedValue: `${PENDING_PREFIX}${candidate.currentTargetText}` }
    }
    if (action === REVIEW_ACTION.KEEP) {
        if (!candidate.placeholderCompatible) {
            throw new Error(
                'Keep is unavailable because the current target has incompatible placeholders'
            )
        }
        if (!wouldRecordAcceptance(candidate, candidate.currentTargetText)) {
            throw new Error(
                'Keep is canonically identical to the committed value, so no acceptance could be recorded. ' +
                    acceptanceRecordingInstruction(candidate)
            )
        }
        return { changed: true, storedValue: candidate.currentTargetText }
    }
    if (action !== REVIEW_ACTION.EDIT) throw new Error(`Unknown review action '${action}'`)

    if (editedTarget === undefined) throw new Error('An Edit action requires target text')
    const problems = reviewEditProblems(candidate, editedTarget)
    if (problems.length > 0) throw new I18nReviewValidationError(problems)
    return { changed: true, storedValue: editedTarget }
}

// Structural inspection cannot tell a broken translation from one whose English moved: both
// look like an accepted value whose placeholders disagree. The second case is the whole reason
// this command exists, so it must not block review. Keep stays unavailable there instead, and
// the runtime already falls back to English.
function blockingReviewIssues(
    locale: Inspection['locales'][number],
    summary: ReturnType<typeof summarizeHistory>
) {
    const entries = summary.locales.get(locale.id)?.entries
    const problems = []
    for (const issue of locale.issues) {
        if (isMechanicalSyncDebt(locale, issue)) continue
        if (
            issue.type === 'placeholder' &&
            (canDeferPlaceholderMismatch(entries?.get(issue.key)) ||
                (entries?.get(issue.key)?.gapIds.length ?? 0) > 0)
        ) {
            continue
        }
        const key = issue.key ? ` key '${issue.key}'` : ''
        problems.push(issue.message ?? `'${locale.id}'${key}: ${issue.detail ?? issue.type}`)
    }
    return problems
}

function targetLocale(inspection: Inspection, localeId: string) {
    const locale = inspection.locales.find(({ id }) => id === localeId)
    if (!locale) {
        const available = inspection.locales.map(({ id }) => id).join(', ')
        throw new Error(`Unknown translation locale '${localeId}'. Available locales: ${available}`)
    }
    return locale
}

function replaceTargetLeaf(bundle: LocaleBundle, targetKey: string, storedValue: string) {
    let replacements = 0

    function replace(value: LocaleBundle, prefix = ''): LocaleBundle {
        const result: LocaleBundle = {}
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

export function prepareI18nReview(
    options: HistoryOptions & { localeId: string; i18nDir?: string }
) {
    const cwd = options.cwd ?? REPOSITORY_ROOT
    const localeDir = options.localeDir ?? I18N_LOCALE_DIR
    const i18nDir = options.i18nDir ?? resolve(cwd, localeDir)
    const inspection = inspectLocales(i18nDir, options.localeId)
    if (inspection.sourceErrors.length > 0) {
        throw new I18nReviewValidationError(inspection.sourceErrors)
    }

    const locale = targetLocale(inspection, options.localeId)

    const committedHistory = analyzeCommittedHistory({
        cwd,
        baseline: options.baseline ?? I18N_HISTORY_BASELINE,
        localeDir,
        revision: options.revision,
        localeId: options.localeId,
    })
    const history = analyzeRepairableProspective(
        committedHistory,
        workingTreeSnapshot(cwd, localeDir, options.localeId)
    )

    const blocking = blockingReviewIssues(locale, summarizeHistory(history))
    if (blocking.length > 0) throw new I18nReviewValidationError(blocking)

    return {
        candidates: buildReviewCandidates(history, options.localeId, committedHistory.snapshot),
        history,
        inspection,
        locale,
        localePath: resolve(i18nDir, `${options.localeId}.json`),
    }
}

function formatCandidate(
    candidate: Candidate,
    position: number,
    total: number,
    styles: ReturnType<typeof createSemanticStyles>
) {
    const status = candidate.placeholderCompatible
        ? 'compatible'
        : 'incompatible (runtime uses English)'
    return [
        `[${position}/${total}] ${candidate.key}`,
        '',
        'English at last accepted checkpoint:',
        candidate.lastAcceptedSourceText === null
            ? '  No proven acceptance is available.'
            : formatSourceText(candidate.lastAcceptedSourceText, styles),
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

const KEEP_UNRECORDABLE = 'the target is canonically identical to the committed value'

function keepBlockedReason(candidate: Candidate) {
    if (!candidate.placeholderCompatible) return 'runtime currently uses English'
    if (!wouldRecordAcceptance(candidate, candidate.currentTargetText)) return KEEP_UNRECORDABLE
    return undefined
}

async function promptAction(candidate: Candidate, ask: Ask, stdout: CliOutput) {
    const blocked = keepBlockedReason(candidate)
    const choices = blocked
        ? `[e] Edit, [s] Skip (Keep unavailable: ${blocked})`
        : '[e] Edit, [k] Keep, [s] Skip'
    while (true) {
        stdout.write(`${choices}\n`)
        const answer = (await ask('> ')).trim().toLowerCase()
        if (answer === 'e' || answer === 'edit') return REVIEW_ACTION.EDIT
        if (answer === 's' || answer === 'skip' || answer === '') return REVIEW_ACTION.SKIP
        if (answer === 'k' || answer === 'keep') {
            if (!blocked) return REVIEW_ACTION.KEEP
            stdout.write(
                `Keep is unavailable because ${blocked}.` +
                    (blocked === KEEP_UNRECORDABLE
                        ? ' ' + acceptanceRecordingInstruction(candidate)
                        : '') +
                    '\n\n'
            )
            continue
        }
        stdout.write('Choose Edit, Keep, or Skip.\n\n')
    }
}

async function promptEditedTarget(
    candidate: Candidate,
    englishName: string,
    ask: Ask,
    stdout: CliOutput
) {
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

function saveReviewedValue(
    review: Review,
    bundle: LocaleBundle,
    candidate: Candidate,
    storedValue: string,
    write: ReviewWriter
) {
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
}: CliIO & { ask: Ask; review: Review; write?: ReviewWriter }) {
    const localeName = localeNativeName(review.locale.id)
    if (review.candidates.length === 0) {
        stdout.write(`${localeName} (${review.locale.id}): no translations need review.\n`)
        return { edited: 0, kept: 0, skipped: 0 }
    }

    stdout.write(
        `${localeName} (${review.locale.id}): ${review.candidates.length} review-pending translation(s)\nPath: ${relative(process.cwd(), review.localePath).replaceAll('\\\\', '/')}\n\nReview actions record your decision; they do not prove linguistic correctness.\nPress Ctrl+C to cancel.\n\n`
    )
    const counts = { edited: 0, kept: 0, skipped: 0 }
    let bundle = review.locale.bundle as LocaleBundle
    const englishName = localeEnglishName(review.locale.id)
    const styles = createSemanticStyles(detectCliCapabilities({ stdout, env }).color)

    const writeSummary = (label: string) => {
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

            let editedTarget: string | undefined
            if (action === REVIEW_ACTION.EDIT) {
                const answer = await promptEditedTarget(candidate, englishName, ask, stdout)
                if (answer === null) {
                    counts.skipped += 1
                    stdout.write('\nSkipped\n\n')
                    continue
                }
                editedTarget = answer
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

async function runSession(review: Review, options: ReviewOptions) {
    if (options.ask) {
        return reviewLocaleSession({
            ask: options.ask,
            review,
            stdout: options.stdout,
            env: options.env,
            write: options.write,
        })
    }

    const input = createInterface({
        input: options.stdin ?? process.stdin,
        output: options.stdout as NodeJS.WritableStream,
    })
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
    args: string[],
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
    }: ReviewOptions = {}
) {
    if (args.length !== 1) {
        stderr.write('Usage: pnpm i18n:review <locale>\n')
        return 2
    }

    const localeId = args[0]!
    try {
        validateLocaleId(localeId)
    } catch (error) {
        stderr.write(`i18n:review: ${errorMessage(error)}\n`)
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
        stderr.write(`i18n:review: ${errorMessage(error)}\n`)
        if (error instanceof I18nHistoryUnavailableError) {
            stderr.write('Full i18n history through the audited baseline is required.\n')
        }
        return 1
    }
}

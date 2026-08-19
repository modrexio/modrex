import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
    parseTargetValue,
    placeholderContract,
    placeholderDifferences,
    TARGET_VALUE_KIND,
    UNTRANSLATED_PREFIX,
} from '../src/shared/i18n-values.js'
import { buildOrderedLocale, inspectTranslationBundle, planFilledLocale } from './i18n-current.mjs'
import { inspectUnicode } from './i18n-diagnostics.mjs'
import { writeLocaleAtomically } from './i18n-files.mjs'
import { buildStatusSummaries } from './i18n-presentation.mjs'
import {
    createSemanticStyles,
    detectCliCapabilities,
    renderPlaceholderText,
    renderStatus,
} from './i18n-presentation-cli.mjs'
import {
    I18N_DIR,
    inspectLocales,
    localeEnglishName,
    localeNativeName,
    SOURCE_LOCALE,
    validateLocaleId,
} from './i18n-inspection.mjs'

export { I18N_DIR, inspectLocales, localeNativeName } from './i18n-inspection.mjs'

export function isUntranslatedValue(value) {
    return parseTargetValue(value).kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD
}

export function formatPercentage(translated, total) {
    const percentage = Math.round((translated / total) * 1000) / 10
    return Number.isInteger(percentage) ? `${percentage}%` : `${percentage.toFixed(1)}%`
}

function validationErrors(inspection) {
    return ['check-i18n: found problems:', ...inspection.errors.map((error) => `  ${error}`)].join(
        '\n'
    )
}

export function formatInspection(inspection) {
    const lines = [`check-i18n: ${inspection.totalCount} source keys`]
    if (inspection.sourceWarnings.length > 0) {
        lines.push(`  en: ${inspection.sourceWarnings.length} warning(s)`)
    }
    for (const locale of inspection.locales) {
        const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
        lines.push(
            `  ${locale.id}: ${locale.translatedCount}/${locale.totalCount} (${percentage}), ${locale.acceptedCount} accepted, ${locale.pendingCount} review, ${locale.missingCount} missing`
        )
        if (locale.pendingPlaceholderIncompatibleCount > 0) {
            const fallbackCount = locale.pendingPlaceholderIncompatibleCount
            lines.push(
                `    ${fallbackCount} review-pending ${fallbackCount === 1 ? 'translation uses' : 'translations use'} English fallback`
            )
        }
        if (locale.warnings.length > 0) lines.push(`    ${locale.warnings.length} warning(s)`)
        if (locale.missingCount > 0) lines.push(`    Next: pnpm i18n:translate ${locale.id}`)
        if (locale.pendingCount > 0) lines.push(`    Next: pnpm i18n:review ${locale.id}`)
    }

    const diagnostics = [
        ...inspection.sourceWarnings.map((issue) => ({
            issue,
            localeName: 'English',
        })),
        ...inspection.locales.flatMap((locale) => [
            ...locale.reviewNotices.map((issue) => ({
                issue,
                localeName: localeNativeName(locale.id),
            })),
            ...locale.warnings.map((issue) => ({
                issue,
                localeName: localeNativeName(locale.id),
            })),
        ]),
    ]
    for (const { issue, localeName } of diagnostics) {
        lines.push('', ...formatLocaleIssue(issue, localeName))
    }
    return lines.join('\n')
}

function translationLocale(inspection, localeId) {
    const locale = inspection.locales.find(({ id }) => id === localeId)
    if (!locale) {
        const available = inspection.locales.map(({ id }) => id).join(', ')
        throw new Error(`Unknown translation locale '${localeId}'. Available locales: ${available}`)
    }
    return locale
}

export function runI18nStatus({
    i18nDir = I18N_DIR,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
} = {}) {
    let inspection
    try {
        inspection = inspectLocales(i18nDir)
        const summaries = buildStatusSummaries(inspection)
        renderStatus({
            summaries,
            capabilities: detectCliCapabilities({ stdout, env }),
            nativeName: localeNativeName,
            stdout,
        })
        return 0
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }
}

function formatPlaceholderNames(names) {
    return names.map((name) => `{${name}}`).join(', ')
}

function formatLocaleIssue(issue, localeName) {
    switch (issue.type) {
        case 'invalid-json':
            return ['File:', '  invalid JSON', `  ${issue.detail ?? 'Could not parse the file'}`]
        case 'invalid-root':
            return ['File:', '  expected a JSON object']
        case 'empty-source':
            return ['File:', '  source locale has no strings']
        case 'empty':
            return [`${issue.key}:`, '  empty translation']
        case 'invalid-value':
            return [`${issue.key}:`, '  expected a string or nested object']
        case 'unknown-key':
            return [
                `${issue.key}:`,
                '  key does not exist in en.json',
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
            ]
        case 'obsolete-target':
            return [
                `${issue.key}:`,
                '  obsolete key contains target-language content',
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
                '  Remove or relocate it manually; i18n:fill will not delete target text.',
            ]
        case 'invalid-marker':
            return [
                `${issue.key}:`,
                '  invalid workflow marker syntax',
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
                `  ${issue.detail}`,
            ]
        case 'empty-marker':
            return [
                `${issue.key}:`,
                '  workflow marker payload must contain non-whitespace text',
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
            ]
        case 'stale-scaffold':
            return [
                `${issue.key}:`,
                '  stale untranslated scaffold',
                `  English: ${JSON.stringify(issue.sourceValue)}`,
                `  Scaffold: ${JSON.stringify(issue.localeValue)}`,
                '  Run pnpm i18n:fill to refresh it.',
            ]
        case 'placeholder': {
            const lines = [
                `${issue.key}:`,
                '  placeholder mismatch',
                `  English: ${JSON.stringify(issue.sourceValue)}`,
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
            ]
            if (issue.missing.length > 0) {
                lines.push(`  Missing placeholder: ${formatPlaceholderNames(issue.missing)}`)
            }
            if (issue.unexpected.length > 0) {
                lines.push(`  Unexpected placeholder: ${formatPlaceholderNames(issue.unexpected)}`)
            }
            return lines
        }
        case 'pending-placeholder': {
            const lines = [
                `${issue.key}:`,
                '  review pending has incompatible placeholders; runtime uses English',
                `  English: ${JSON.stringify(issue.sourceValue)}`,
                `  ${localeName}: ${JSON.stringify(issue.localeValue)}`,
            ]
            if (issue.missing.length > 0) {
                lines.push(`  Missing placeholder: ${formatPlaceholderNames(issue.missing)}`)
            }
            if (issue.unexpected.length > 0) {
                lines.push(`  Unexpected placeholder: ${formatPlaceholderNames(issue.unexpected)}`)
            }
            return lines
        }
        case 'unicode': {
            const codePoint = issue.codePoint ? ` ${issue.codePoint}` : ''
            const name = issue.name ? ` (${issue.name})` : ''
            const position = Number.isInteger(issue.position)
                ? ` at position ${issue.position}`
                : ''
            return [
                `${issue.key}:`,
                `  ${issue.severity}${codePoint}${name}${position}: ${issue.description}`,
            ]
        }
        default:
            throw new Error(`Unknown locale validation issue '${issue.type}'`)
    }
}

export function formatLocaleReport(inspection, localeId) {
    const locale = translationLocale(inspection, localeId)
    const localeName = localeNativeName(locale.id)
    const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
    const coverage = `Coverage: ${locale.translatedCount}/${locale.totalCount} translated (${percentage})`
    const missing = `Missing: ${locale.missingKeys.length} ${locale.missingKeys.length === 1 ? 'key' : 'keys'}`

    const lines = [`${locale.id}.json`]
    if (locale.issues.length === 0) {
        lines.push('Valid')
    } else {
        const problemLabel =
            locale.issues.length === 1 ? 'validation problem' : 'validation problems'
        lines.push(`${locale.issues.length} ${problemLabel}`)
    }
    for (const issue of locale.issues) {
        lines.push('', ...formatLocaleIssue(issue, localeName))
    }
    for (const notice of locale.reviewNotices) {
        lines.push('', ...formatLocaleIssue(notice, localeName))
    }
    for (const warning of locale.warnings) {
        lines.push('', ...formatLocaleIssue(warning, localeName))
    }
    for (const warning of inspection.sourceWarnings) {
        lines.push('', 'English source warning', ...formatLocaleIssue(warning, 'English'))
    }
    lines.push('', coverage, missing)
    if (locale.missingKeys.length > 0) lines.push(`Next: pnpm i18n:translate ${locale.id}`)
    if (locale.pendingCount > 0) {
        lines.push(`Review pending: ${locale.pendingCount}`, `Next: pnpm i18n:review ${locale.id}`)
    }
    if (locale.pendingPlaceholderIncompatibleCount > 0) {
        lines.push(
            `English fallback: ${locale.pendingPlaceholderIncompatibleCount} pending translation(s)`
        )
    }
    return lines.join('\n')
}

function formatSourceReport(inspection) {
    const lines = [`${inspection.sourceLocale}.json`]
    if (inspection.sourceIssues.length === 0) {
        lines.push('Valid')
    } else {
        const problemLabel =
            inspection.sourceIssues.length === 1 ? 'validation problem' : 'validation problems'
        lines.push(`${inspection.sourceIssues.length} ${problemLabel}`)
    }
    for (const issue of inspection.sourceIssues) {
        lines.push('', ...formatLocaleIssue(issue, 'English'))
    }
    for (const warning of inspection.sourceWarnings) {
        lines.push('', ...formatLocaleIssue(warning, 'English'))
    }
    lines.push('', `Source strings: ${inspection.totalCount}`)
    return lines.join('\n')
}

export function formatMissingReport(inspection, localeId, styles) {
    const locale = translationLocale(inspection, localeId)

    const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
    const missingLabel = locale.missingKeys.length === 1 ? 'missing key' : 'missing keys'
    const lines = [
        `${localeNativeName(locale.id)} (${locale.id}): ${locale.translatedCount}/${locale.totalCount} translated, ${percentage}`,
        `${locale.missingKeys.length} ${missingLabel}`,
    ]

    for (const [index, key] of locale.missingKeys.entries()) {
        lines.push(
            '',
            `${index + 1}. ${key}`,
            `  English: ${renderPlaceholderText(JSON.stringify(inspection.sourceStrings[key]), styles)}`
        )
    }
    if (locale.missingKeys.length > 0) lines.push('', `Next: pnpm i18n:translate ${locale.id}`)
    return lines.join('\n')
}

function formatSourceText(value, styles) {
    return value
        .split('\n')
        .map((line) => `  ${renderPlaceholderText(line, styles)}`)
        .join('\n')
}

function formatTranslationProblems(sourceValue, localeValue) {
    let targetValue
    try {
        targetValue = parseTargetValue(localeValue)
    } catch (error) {
        return [`  Invalid workflow marker syntax: ${error.message}`]
    }
    if (targetValue.kind !== TARGET_VALUE_KIND.ACCEPTED) {
        return ['  A translation must not begin with the reserved "! " or "? " prefix.']
    }

    const { missing, unexpected } = placeholderDifferences(
        placeholderContract(sourceValue),
        targetValue.placeholderContract
    )
    const lines = []
    if (missing.length > 0) {
        lines.push(`  Missing placeholder: ${formatPlaceholderNames(missing)}`)
    }
    if (unexpected.length > 0) {
        lines.push(`  Unexpected placeholder: ${formatPlaceholderNames(unexpected)}`)
    }
    for (const finding of inspectUnicode(localeValue)) {
        if (finding.severity !== 'error') continue
        lines.push(
            `  Unsafe Unicode: ${finding.codePoint ?? finding.description}${finding.name ? ` (${finding.name})` : ''}`
        )
    }
    return lines
}

async function promptTranslation({
    ask,
    stdout,
    sourceLabel,
    sourceValue,
    translationLabel,
    styles,
}) {
    stdout.write(
        `${sourceLabel}:\n${formatSourceText(sourceValue, styles)}\n\n${translationLabel} (Enter to skip):\n`
    )

    while (true) {
        const answer = await ask('> ')
        if (answer.trim().length === 0) return null

        const problems = formatTranslationProblems(sourceValue, answer)
        if (problems.length === 0) return answer

        stdout.write(
            `\nInvalid translation:\n${problems.join('\n')}\n\nEnter the translation again, or press Enter to skip:\n`
        )
    }
}

function translationUnits(missingKeys, pairedKeys) {
    const pairByKey = new Map()
    for (const [plural, single] of pairedKeys) {
        pairByKey.set(plural, { plural, single })
        pairByKey.set(single, { plural, single })
    }

    const positions = new Map(missingKeys.map((key, index) => [key, index + 1]))
    const missingKeySet = new Set(missingKeys)
    const handledPairs = new Set()
    const units = []
    for (const key of missingKeys) {
        const pair = pairByKey.get(key)
        if (!pair) {
            units.push({ type: 'single', key, position: positions.get(key) })
            continue
        }
        if (handledPairs.has(pair.plural)) continue

        handledPairs.add(pair.plural)
        const bothMissing = missingKeySet.has(pair.plural) && missingKeySet.has(pair.single)
        if (!bothMissing) {
            const counterpart = key === pair.plural ? pair.single : pair.plural
            units.push({ type: 'single', key, position: positions.get(key), counterpart })
            continue
        }
        const pairPositions = [positions.get(pair.plural), positions.get(pair.single)].sort(
            (a, b) => a - b
        )
        units.push({ type: 'pair', ...pair, positions: pairPositions })
    }
    return units
}

async function promptPair(unit, context) {
    const { ask, englishName, inspection, stdout, styles } = context
    while (true) {
        const singular = await promptTranslation({
            ask,
            stdout,
            sourceLabel: 'Singular English source',
            sourceValue: inspection.sourceStrings[unit.single],
            translationLabel: `${englishName} singular translation`,
            styles,
        })
        stdout.write('\n')
        const plural = await promptTranslation({
            ask,
            stdout,
            sourceLabel: 'Plural English source',
            sourceValue: inspection.sourceStrings[unit.plural],
            translationLabel: `${englishName} plural translation`,
            styles,
        })

        if (singular === null && plural === null) return null
        if (singular !== null && plural !== null) {
            return [
                [unit.single, singular],
                [unit.plural, plural],
            ]
        }

        stdout.write(
            '\nSingular/plural translations must be completed together.\n\nRe-enter both translations or skip both.\n\n'
        )
    }
}

async function promptUnit(unit, context) {
    const { ask, englishName, inspection, stdout, styles } = context
    if (unit.type === 'pair') {
        const [first, second] = unit.positions
        stdout.write(
            `[${first}-${second}/${context.totalMissing}] ${unit.single} / ${unit.plural}\n\n`
        )
        return promptPair(unit, context)
    }

    stdout.write(`[${unit.position}/${context.totalMissing}] ${unit.key}\n\n`)
    if (unit.counterpart) {
        const counterpart = context.locale.targetValues[unit.counterpart]
        stdout.write(
            `Existing counterpart (${unit.counterpart}):\n${formatSourceText(counterpart.targetText, styles)}\n\n`
        )
    }
    const translation = await promptTranslation({
        ask,
        stdout,
        sourceLabel: 'English source',
        sourceValue: inspection.sourceStrings[unit.key],
        translationLabel: `${englishName} translation`,
        styles,
    })
    return translation === null ? null : [[unit.key, translation]]
}

function formatInteractiveStatus(localeName, locale) {
    const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
    const missingLabel = locale.missingKeys.length === 1 ? 'missing key' : 'missing keys'
    return `${localeName} (${locale.id})\n\n${locale.translatedCount}/${locale.totalCount} translated - ${percentage}\n${locale.missingKeys.length} ${missingLabel}`
}

function localeDisplayPath(localePath) {
    return relative(process.cwd(), localePath).replaceAll('\\', '/')
}

async function translateLocaleSession({
    ask,
    inspection,
    locale,
    localePath,
    stdout,
    env = process.env,
}) {
    const localeName = localeNativeName(locale.id)
    const englishName = localeEnglishName(locale.id)

    if (locale.missingKeys.length === 0) {
        const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
        stdout.write(
            `${localeName} (${locale.id})\nPath: ${localeDisplayPath(localePath)}\n\n${locale.translatedCount}/${locale.totalCount} translated, ${percentage}\n\nNo missing translations.\nLocale is valid\n`
        )
        return
    }

    stdout.write(`${localeName} (${locale.id})\nPath: ${localeDisplayPath(localePath)}\n`)
    stdout.write(
        `\n${locale.translatedCount}/${locale.totalCount} translated - ${locale.missingKeys.length} missing\nMarker reminder: ! means translate this; no prefix means accepted translation.\n\nPress Ctrl+C to cancel.\n\n`
    )

    let current = locale
    let saved = 0
    let skipped = 0
    const units = translationUnits(locale.missingKeys, inspection.pairedKeys)
    const context = {
        ask,
        englishName,
        inspection,
        locale,
        styles: createSemanticStyles(detectCliCapabilities({ stdout, env }).color),
        stdout,
        totalMissing: locale.missingKeys.length,
    }

    for (const unit of units) {
        const completed = await promptUnit(unit, context)
        if (completed === null) {
            skipped += 1
            stdout.write('\n')
            continue
        }

        const translated = { ...current.strings }
        for (const [key, value] of completed) translated[key] = value
        const ordered = buildOrderedLocale(inspection.sourceBundle, translated)
        const candidate = inspectTranslationBundle(
            locale.id,
            ordered,
            inspection.sourceStrings,
            inspection.sourceKeys,
            inspection.pairedKeys
        )
        if (candidate.errors.length > 0) {
            throw new Error(validationErrors(candidate))
        }

        writeLocaleAtomically(localePath, ordered)
        current = candidate
        saved += 1
        stdout.write('\nSaved\n\n')
    }

    stdout.write(
        `\n${formatInteractiveStatus(localeName, current)}\nSaved: ${saved}\nSkipped: ${skipped}\nRemaining: ${current.missingKeys.length}\nProgress already written remains saved.\n\n`
    )
    stdout.write('Locale is valid\n')
}

function usageText() {
    return [
        'Modrex translation CLI',
        '',
        '!  translate this',
        '?  review this',
        'no prefix  accepted translation',
        '',
        'Inspect',
        '  pnpm i18n:help               Show this workflow guide',
        '  pnpm i18n:status             Show all languages and key coverage',
        '  pnpm i18n:check [locale]     Validate the source or one locale',
        '  pnpm i18n:missing <locale>   List missing keys with English source text',
        '',
        'Prepare',
        '  pnpm i18n:fill <locale>      Fill an existing locale with marked English text',
        '  pnpm i18n:create <locale>    Create an IDE-ready locale with marked English text',
        '  pnpm i18n:sync               Reconcile locale workflow state',
        '',
        'Translate',
        '  pnpm i18n:translate <locale> Continue an existing locale',
        '  pnpm i18n:review <locale>    Review Pending target translations',
    ].join('\n')
}

function runScaffoldI18n(
    command,
    localeId,
    { i18nDir = I18N_DIR, stdout = process.stdout, stderr = process.stderr } = {}
) {
    try {
        validateLocaleId(localeId)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 2
    }

    if (localeId === SOURCE_LOCALE) {
        stderr.write(`Locale '${SOURCE_LOCALE}' is the English source, not a target locale.\n`)
        return 2
    }

    let inspection
    try {
        inspection = inspectLocales(i18nDir)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }
    if (inspection.sourceErrors.length > 0) {
        stderr.write(`${validationErrors({ errors: inspection.sourceErrors })}\n`)
        return 1
    }

    const localePath = resolve(i18nDir, `${localeId}.json`)
    const localeExists = existsSync(localePath)
    const create = command === '--create'
    if (create && localeExists) {
        stderr.write(
            `Locale '${localeId}' already exists.\n\nAdd its missing keys with:\n  pnpm i18n:fill ${localeId}\n`
        )
        return 1
    }
    if (!create && !localeExists) {
        stderr.write(
            `Locale '${localeId}' does not exist.\n\nCreate it with:\n  pnpm i18n:create ${localeId}\n`
        )
        return 1
    }

    const locale = localeExists
        ? translationLocale(inspection, localeId)
        : inspectTranslationBundle(localeId, {}, inspection.sourceStrings, inspection.sourceKeys)
    const plan = planFilledLocale(inspection, locale)
    if (plan.errors.length > 0) {
        const localeName = localeNativeName(locale.id)
        const problemLabel = plan.errors.length === 1 ? 'validation problem' : 'validation problems'
        const lines = [`${locale.id}.json`, `${plan.errors.length} ${problemLabel}`]
        for (const issue of plan.errors) lines.push('', ...formatLocaleIssue(issue, localeName))
        stderr.write(`${lines.join('\n')}\n`)
        return 1
    }

    const ordered = plan.bundle
    const candidate = inspectTranslationBundle(
        localeId,
        ordered,
        inspection.sourceStrings,
        inspection.sourceKeys
    )
    if (candidate.errors.length > 0) {
        stderr.write(`${validationErrors(candidate)}\n`)
        return 1
    }

    let changed
    try {
        changed = writeLocaleAtomically(localePath, ordered)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }
    const action = create ? 'Created' : 'Updated'
    if (!changed) {
        stdout.write(`${localeNativeName(localeId)} (${localeId}) is already canonical.\n`)
        return 0
    }
    stdout.write(
        `${action} ${localeDisplayPath(localePath)}.\nScaffolds added: ${plan.addedScaffolds}\nScaffolds refreshed: ${plan.refreshedScaffolds}\nObsolete scaffolds removed: ${plan.removedScaffolds}\nTarget-language text preserved.\nReplace values starting with "${UNTRANSLATED_PREFIX}" as you translate.\nCoverage remains ${formatPercentage(candidate.translatedCount, candidate.totalCount)}.\n`
    )
    if (candidate.missingKeys.length > 0) stdout.write(`Next: pnpm i18n:translate ${localeId}\n`)
    return 0
}

export function runCheckI18n(
    args,
    { i18nDir = I18N_DIR, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}
) {
    const usage = usageText()
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        stdout.write(`${usage}\n`)
        return 0
    }

    const supported =
        args.length === 0 ||
        (args.length === 1 && args[0] === '--status') ||
        (args.length === 2 && ['--missing', '--locale'].includes(args[0]))
    if (!supported) {
        stderr.write(`${usage}\n`)
        return 2
    }

    if (args[0] === '--status') return runI18nStatus({ i18nDir, stdout, stderr, env })

    let inspection
    try {
        inspection = inspectLocales(i18nDir)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }

    if (args[0] === '--locale') {
        if (args[1] === SOURCE_LOCALE) {
            const report = `${formatSourceReport(inspection)}\n`
            if (inspection.sourceErrors.length > 0) {
                stderr.write(report)
                return 1
            }
            stdout.write(report)
            return 0
        }

        if (inspection.sourceErrors.length > 0) {
            stderr.write(`${validationErrors({ errors: inspection.sourceErrors })}\n`)
            return 1
        }

        try {
            const locale = translationLocale(inspection, args[1])
            const report = `${formatLocaleReport(inspection, locale.id)}\n`
            if (locale.issues.length > 0) {
                stderr.write(report)
                return 1
            }
            stdout.write(report)
            return 0
        } catch (error) {
            stderr.write(`check-i18n: ${error.message}\n`)
            return 2
        }
    }

    if (args.length === 2 && args[0] === '--missing') {
        if (inspection.sourceErrors.length > 0) {
            stderr.write(`${validationErrors({ errors: inspection.sourceErrors })}\n`)
            return 1
        }
        try {
            const locale = translationLocale(inspection, args[1])
            if (locale.issues.length > 0) {
                stderr.write(`${formatLocaleReport(inspection, locale.id)}\n`)
                return 1
            }
            const styles = createSemanticStyles(detectCliCapabilities({ stdout, env }).color)
            stdout.write(`${formatMissingReport(inspection, locale.id, styles)}\n`)
            return 0
        } catch (error) {
            stderr.write(`check-i18n: ${error.message}\n`)
            return 2
        }
    }

    if (inspection.errors.length > 0) {
        stderr.write(`${validationErrors(inspection)}\n`)
        return 1
    }

    if (args.length === 0) {
        stdout.write(`${formatInspection(inspection)}\n`)
        return 0
    }

    throw new Error('Supported i18n arguments were not handled')
}

async function runSessionWithInput(session, { ask, stdin, stdout }) {
    if (ask) return translateLocaleSession({ ...session, ask })

    const input = createInterface({ input: stdin, output: stdout })
    try {
        return await translateLocaleSession({
            ...session,
            ask: (question) => input.question(question),
        })
    } finally {
        input.close()
    }
}

async function runInteractiveI18n(
    localeId,
    {
        ask,
        i18nDir = I18N_DIR,
        stdin = process.stdin,
        stdout = process.stdout,
        stderr = process.stderr,
        env = process.env,
    } = {}
) {
    try {
        validateLocaleId(localeId)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 2
    }

    if (localeId === SOURCE_LOCALE) {
        stderr.write(
            `Locale '${SOURCE_LOCALE}' is the English source and is not translated here.\n`
        )
        return 2
    }

    const localePath = resolve(i18nDir, `${localeId}.json`)
    if (!existsSync(localePath)) {
        stderr.write(
            `Locale '${localeId}' does not exist.\n\nCreate it with:\n  pnpm i18n:create ${localeId}\n`
        )
        return 1
    }

    let inspection
    try {
        inspection = inspectLocales(i18nDir)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }
    if (inspection.sourceErrors.length > 0) {
        stderr.write(`${validationErrors({ errors: inspection.sourceErrors })}\n`)
        return 1
    }

    const locale = translationLocale(inspection, localeId)
    if (locale.issues.length > 0) {
        stderr.write(`${formatLocaleReport(inspection, locale.id)}\n`)
        return 1
    }

    try {
        await runSessionWithInput(
            { inspection, locale, localePath, stdout, env },
            { ask, stdin, stdout }
        )
        return 0
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }
}

export async function runI18nCli(args, options = {}) {
    const localeCheck = args.length === 1 && !args[0].startsWith('-')
    if (localeCheck) return runCheckI18n(['--locale', args[0]], options)

    if (args[0] === '--sync') {
        const { runI18nSync } = await import('./i18n-sync.mjs')
        return runI18nSync(args.slice(1), options)
    }

    if (args[0] === '--review') {
        const { runI18nReview } = await import('./i18n-review.mjs')
        return runI18nReview(args.slice(1), options)
    }

    if (args.length === 2 && ['--fill', '--create'].includes(args[0])) {
        return runScaffoldI18n(args[0], args[1], options)
    }

    if (args.length === 2 && args[0] === '--translate') {
        return runInteractiveI18n(args[1], options)
    }
    return runCheckI18n(args, options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await runI18nCli(process.argv.slice(2))
}

import { randomUUID } from 'node:crypto'
import {
    existsSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_LOCALE = 'en'
const UNTRANSLATED_PREFIX = '! '
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const I18N_DIR = resolve(SCRIPT_DIR, '../src/renderer/src/i18n')

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function flattenBundle(value, localeId, errors, prefix = '', issues = []) {
    const flat = Object.create(null)
    if (!isPlainObject(value)) {
        errors.push(`'${localeId}' must contain a JSON object`)
        issues.push({ type: 'invalid-root' })
        return flat
    }

    for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof child === 'string') {
            if (child.trim().length === 0) {
                errors.push(`'${localeId}' key '${path}' is empty`)
                issues.push({ type: 'empty', key: path })
            }
            flat[path] = child
            continue
        }
        if (isPlainObject(child)) {
            Object.assign(flat, flattenBundle(child, localeId, errors, path, issues))
            continue
        }
        errors.push(`'${localeId}' key '${path}' must be a string or object`)
        issues.push({ type: 'invalid-value', key: path })
    }
    return flat
}

function interpolationVars(value) {
    return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

function missingVars(expected, actual) {
    const remaining = [...actual]
    return expected.filter((name) => {
        const index = remaining.indexOf(name)
        if (index === -1) return true
        remaining.splice(index, 1)
        return false
    })
}

function placeholderDifferences(sourceValue, localeValue) {
    const sourceVars = interpolationVars(sourceValue)
    const localeVars = interpolationVars(localeValue)
    return {
        missing: missingVars(sourceVars, localeVars),
        unexpected: missingVars(localeVars, sourceVars),
    }
}

export function isUntranslatedValue(value) {
    return value.startsWith(UNTRANSLATED_PREFIX)
}

function parseBundle(path, localeId) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`Failed to parse locale '${localeId}' at ${path}`, { cause: error })
    }
}

function validateLocaleId(id) {
    let canonical
    try {
        canonical = Intl.getCanonicalLocales(id)[0]
    } catch (error) {
        throw new Error(`Locale filename '${id}.json' is not a valid locale code`, {
            cause: error,
        })
    }
    if (canonical !== id) {
        throw new Error(
            `Locale filename '${id}.json' must use canonical casing '${canonical}.json'`
        )
    }
}

export function formatPercentage(translated, total) {
    const percentage = Math.round((translated / total) * 1000) / 10
    return Number.isInteger(percentage) ? `${percentage}%` : `${percentage.toFixed(1)}%`
}

export function localeNativeName(localeId) {
    const name = new Intl.DisplayNames([localeId], { type: 'language' }).of(localeId)
    if (!name) throw new Error(`Intl.DisplayNames could not name locale '${localeId}'`)
    return name.charAt(0).toLocaleUpperCase(localeId) + name.slice(1)
}

function localeEnglishName(localeId) {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(localeId)
    if (!name) throw new Error(`Intl.DisplayNames could not name locale '${localeId}' in English`)
    return name.charAt(0).toUpperCase() + name.slice(1)
}

function singularPluralPairs(sourceKeys) {
    return sourceKeys
        .filter((key) => key.endsWith('Single'))
        .map((single) => [single.slice(0, -'Single'.length), single])
        .filter(([plural]) => sourceKeys.includes(plural))
}

function inspectTranslationBundle(id, bundle, sourceFlat, sourceKeys, pairedKeys) {
    const errors = []
    const issues = []
    const bundleFlat = flattenBundle(bundle, id, errors, '', issues)
    const translatedKeys = sourceKeys.filter(
        (key) => Object.hasOwn(bundleFlat, key) && !isUntranslatedValue(bundleFlat[key])
    )
    const translatedKeySet = new Set(translatedKeys)
    const missingKeys = sourceKeys.filter((key) => !translatedKeySet.has(key))
    const extraKeys = Object.keys(bundleFlat).filter((key) => !Object.hasOwn(sourceFlat, key))

    if (extraKeys.length > 0) {
        errors.push(`'${id}' has key(s) not present in en.json:\n  ${extraKeys.join('\n  ')}`)
        for (const key of extraKeys) {
            issues.push({ type: 'unknown-key', key, localeValue: bundleFlat[key] })
        }
    }

    for (const [plural, single] of pairedKeys) {
        if (translatedKeySet.has(plural) === translatedKeySet.has(single)) continue
        errors.push(`'${id}' must translate '${plural}' and '${single}' together`)
        issues.push({ type: 'plural-pair', plural, single })
    }

    for (const key of translatedKeys) {
        const { missing, unexpected } = placeholderDifferences(sourceFlat[key], bundleFlat[key])
        if (missing.length === 0 && unexpected.length === 0) continue
        const localeVars = interpolationVars(bundleFlat[key])
        const sourceVars = interpolationVars(sourceFlat[key])
        errors.push(
            `'${id}' key '${key}' has interpolation vars [${localeVars.join(',')}], expected [${sourceVars.join(',')}]`
        )
        issues.push({
            type: 'placeholder',
            key,
            sourceValue: sourceFlat[key],
            localeValue: bundleFlat[key],
            missing,
            unexpected,
        })
    }

    return {
        id,
        errors,
        issues,
        strings: bundleFlat,
        translatedKeys,
        missingKeys,
        extraKeys,
        translatedCount: translatedKeys.length,
        totalCount: sourceKeys.length,
    }
}

export function inspectLocales(i18nDir = I18N_DIR) {
    const localeIds = readdirSync(i18nDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace(/\.json$/, ''))
        .sort((a, b) => {
            if (a === SOURCE_LOCALE) return -1
            if (b === SOURCE_LOCALE) return 1
            return a < b ? -1 : a > b ? 1 : 0
        })

    if (!localeIds.includes(SOURCE_LOCALE)) {
        throw new Error(`Source locale '${SOURCE_LOCALE}.json' is missing from ${i18nDir}`)
    }
    for (const id of localeIds) validateLocaleId(id)

    const errors = []
    const source = parseBundle(resolve(i18nDir, `${SOURCE_LOCALE}.json`), SOURCE_LOCALE)
    const sourceFlat = flattenBundle(source, SOURCE_LOCALE, errors)
    const sourceKeys = Object.keys(sourceFlat)
    const pairedKeys = singularPluralPairs(sourceKeys)
    if (sourceKeys.length === 0) errors.push(`Source locale '${SOURCE_LOCALE}' has no strings`)
    const sourceErrors = [...errors]

    const locales = []
    for (const id of localeIds) {
        if (id === SOURCE_LOCALE) continue

        const issues = []
        let bundle
        try {
            bundle = parseBundle(resolve(i18nDir, `${id}.json`), id)
        } catch (error) {
            errors.push(error.message)
            issues.push({ type: 'invalid-json', detail: error.cause?.message })
            locales.push({
                id,
                errors: [error.message],
                issues,
                strings: Object.create(null),
                translatedKeys: [],
                missingKeys: sourceKeys,
                extraKeys: [],
                translatedCount: 0,
                totalCount: sourceKeys.length,
            })
            continue
        }

        const locale = inspectTranslationBundle(id, bundle, sourceFlat, sourceKeys, pairedKeys)
        errors.push(...locale.errors)
        locales.push(locale)
    }

    return {
        errors,
        locales,
        sourceErrors,
        sourceBundle: source,
        sourceLocale: SOURCE_LOCALE,
        pairedKeys,
        sourceKeys,
        sourceStrings: sourceFlat,
        totalCount: sourceKeys.length,
    }
}

function validationErrors(inspection) {
    return ['check-i18n: found problems:', ...inspection.errors.map((error) => `  ${error}`)].join(
        '\n'
    )
}

export function formatInspection(inspection) {
    const lines = [`check-i18n: ${inspection.totalCount} source keys`]
    for (const locale of inspection.locales) {
        const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
        const missing =
            locale.missingKeys.length === 0 ? '' : `, ${locale.missingKeys.length} missing`
        lines.push(
            `  ${locale.id}: ${locale.translatedCount}/${locale.totalCount} (${percentage})${missing}`
        )
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

export function formatStatus(inspection) {
    const rows = [
        {
            label: `${localeNativeName(inspection.sourceLocale)} (${inspection.sourceLocale})`,
            coverage: formatPercentage(inspection.totalCount, inspection.totalCount),
        },
        ...inspection.locales.map((locale) => ({
            label: `${localeNativeName(locale.id)} (${locale.id})`,
            coverage: formatPercentage(locale.translatedCount, locale.totalCount),
        })),
    ]
    const labelWidth = Math.max(...rows.map(({ label }) => label.length))
    return [
        'Available languages',
        '',
        ...rows.map(
            ({ label, coverage }) => `${label.padEnd(labelWidth)}  ${coverage.padStart(6)}`
        ),
    ].join('\n')
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
        case 'plural-pair':
            return [
                `${issue.plural} / ${issue.single}:`,
                '  singular/plural pair incomplete',
                '  Translate both keys together.',
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

    if (locale.issues.length === 0) {
        return [`${locale.id}.json`, 'Valid', coverage, missing].join('\n')
    }

    const problemLabel = locale.issues.length === 1 ? 'validation problem' : 'validation problems'
    const lines = [`${locale.id}.json`, `${locale.issues.length} ${problemLabel}`]
    for (const issue of locale.issues) {
        lines.push('', ...formatLocaleIssue(issue, localeName))
    }
    lines.push('', coverage, missing)
    return lines.join('\n')
}

export function formatMissingReport(inspection, localeId) {
    const locale = translationLocale(inspection, localeId)

    const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
    const missingLabel = locale.missingKeys.length === 1 ? 'missing key' : 'missing keys'
    const lines = [
        `${localeNativeName(locale.id)} (${locale.id}): ${locale.translatedCount}/${locale.totalCount} translated, ${percentage}`,
        `${locale.missingKeys.length} ${missingLabel}`,
    ]

    for (const key of locale.missingKeys) {
        lines.push('', key, `  English: ${JSON.stringify(inspection.sourceStrings[key])}`)
    }
    return lines.join('\n')
}

function buildOrderedLocale(source, translated, prefix = '') {
    const locale = {}
    for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') {
            if (Object.hasOwn(translated, path)) locale[key] = translated[path]
            continue
        }

        const child = buildOrderedLocale(value, translated, path)
        if (Object.keys(child).length > 0) locale[key] = child
    }
    return locale
}

function writeLocaleAtomically(localePath, locale) {
    const temporaryPath = resolve(
        dirname(localePath),
        `.${basename(localePath)}.${randomUUID()}.tmp`
    )
    writeFileSync(temporaryPath, `${JSON.stringify(locale, null, 4)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    })

    try {
        renameSync(temporaryPath, localePath)
    } catch (error) {
        try {
            unlinkSync(temporaryPath)
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Failed to replace '${localePath}' and remove temporary file '${temporaryPath}'`
            )
        }
        throw new Error(`Failed to replace locale file '${localePath}'`, { cause: error })
    }
}

function formatSourceText(value) {
    return value
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
}

function formatPlaceholderProblems(sourceValue, localeValue) {
    const { missing, unexpected } = placeholderDifferences(sourceValue, localeValue)
    const lines = []
    if (missing.length > 0) {
        lines.push(`  Missing placeholder: ${formatPlaceholderNames(missing)}`)
    }
    if (unexpected.length > 0) {
        lines.push(`  Unexpected placeholder: ${formatPlaceholderNames(unexpected)}`)
    }
    return lines
}

async function promptTranslation({ ask, stdout, sourceLabel, sourceValue, translationLabel }) {
    stdout.write(
        `${sourceLabel}:\n${formatSourceText(sourceValue)}\n\n${translationLabel} (Enter to skip):\n`
    )

    while (true) {
        const answer = await ask('> ')
        if (answer.trim().length === 0) return null

        const problems = formatPlaceholderProblems(sourceValue, answer)
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
        const pairPositions = [positions.get(pair.plural), positions.get(pair.single)].sort(
            (a, b) => a - b
        )
        units.push({ type: 'pair', ...pair, positions: pairPositions })
    }
    return units
}

async function promptPair(unit, context) {
    const { ask, englishName, inspection, stdout } = context
    while (true) {
        const singular = await promptTranslation({
            ask,
            stdout,
            sourceLabel: 'Singular English source',
            sourceValue: inspection.sourceStrings[unit.single],
            translationLabel: `${englishName} singular translation`,
        })
        stdout.write('\n')
        const plural = await promptTranslation({
            ask,
            stdout,
            sourceLabel: 'Plural English source',
            sourceValue: inspection.sourceStrings[unit.plural],
            translationLabel: `${englishName} plural translation`,
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
    const { ask, englishName, inspection, stdout } = context
    if (unit.type === 'pair') {
        const [first, second] = unit.positions
        stdout.write(
            `[${first}-${second}/${context.totalMissing}] ${unit.single} / ${unit.plural}\n\n`
        )
        return promptPair(unit, context)
    }

    stdout.write(`[${unit.position}/${context.totalMissing}] ${unit.key}\n\n`)
    const translation = await promptTranslation({
        ask,
        stdout,
        sourceLabel: 'English source',
        sourceValue: inspection.sourceStrings[unit.key],
        translationLabel: `${englishName} translation`,
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

async function translateLocaleSession({ ask, inspection, locale, localePath, stdout }) {
    const localeName = localeNativeName(locale.id)
    const englishName = localeEnglishName(locale.id)

    if (locale.missingKeys.length === 0) {
        const percentage = formatPercentage(locale.translatedCount, locale.totalCount)
        stdout.write(
            `${localeName} (${locale.id}): ${locale.translatedCount}/${locale.totalCount} translated, ${percentage}\n\nNo missing translations.\nLocale is valid\n`
        )
        return
    }

    stdout.write(`${localeName} (${locale.id})\n`)
    stdout.write(
        `\n${locale.translatedCount}/${locale.totalCount} translated - ${locale.missingKeys.length} missing\n\nPress Ctrl+C to cancel.\n\n`
    )

    let current = locale
    const units = translationUnits(locale.missingKeys, inspection.pairedKeys)
    const context = {
        ask,
        englishName,
        inspection,
        stdout,
        totalMissing: locale.missingKeys.length,
    }

    for (const unit of units) {
        const completed = await promptUnit(unit, context)
        if (completed === null) {
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
        stdout.write('\nSaved\n\n')
    }

    stdout.write(`\n${formatInteractiveStatus(localeName, current)}\n\n`)
    stdout.write('Locale is valid\n')
}

function usageText() {
    return [
        'Modrex translation CLI',
        '',
        '  pnpm i18n:help               Show this help',
        '  pnpm i18n:status             Show all languages and key coverage',
        '  pnpm i18n:check              Validate every locale',
        '  pnpm i18n:check <locale>     Validate one locale with actionable details',
        '  pnpm i18n:missing <locale>   List missing keys with English source text',
        '  pnpm i18n:fill <locale>      Fill an existing locale with marked English text',
        '  pnpm i18n:translate <locale> Interactively continue an existing locale',
        '  pnpm i18n:create <locale>    Create an IDE-ready locale with marked English text',
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
        return 1
    }

    if (localeId === SOURCE_LOCALE) {
        stderr.write(`Locale '${SOURCE_LOCALE}' is the English source and cannot be filled.\n`)
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
        : inspectTranslationBundle(
              localeId,
              {},
              inspection.sourceStrings,
              inspection.sourceKeys,
              inspection.pairedKeys
          )
    if (locale.issues.length > 0) {
        stderr.write(`${formatLocaleReport(inspection, locale.id)}\n`)
        return 1
    }

    if (locale.missingKeys.length === 0) {
        stdout.write(`${localeNativeName(localeId)} (${localeId}) is complete. No changes made.\n`)
        return 0
    }

    const strings = { ...locale.strings }
    for (const key of locale.missingKeys) {
        strings[key] = `${UNTRANSLATED_PREFIX}${inspection.sourceStrings[key]}`
    }
    const ordered = buildOrderedLocale(inspection.sourceBundle, strings)
    const candidate = inspectTranslationBundle(
        localeId,
        ordered,
        inspection.sourceStrings,
        inspection.sourceKeys,
        inspection.pairedKeys
    )
    if (candidate.errors.length > 0) {
        stderr.write(`${validationErrors(candidate)}\n`)
        return 1
    }

    writeLocaleAtomically(localePath, ordered)
    const action = create ? 'Created' : 'Updated'
    stdout.write(
        `${action} ${localeDisplayPath(localePath)} with ${locale.missingKeys.length} marked English fallbacks.\nReplace values starting with "${UNTRANSLATED_PREFIX}" as you translate.\nCoverage remains ${formatPercentage(candidate.translatedCount, candidate.totalCount)}.\n`
    )
    return 0
}

export function runCheckI18n(
    args,
    { i18nDir = I18N_DIR, stdout = process.stdout, stderr = process.stderr } = {}
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

    let inspection
    try {
        inspection = inspectLocales(i18nDir)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }

    if (args[0] === '--locale') {
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
            return 1
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

    if (args[0] === '--status') {
        stdout.write(`${formatStatus(inspection)}\n`)
        return 0
    }

    if (args.length === 2 && args[0] === '--missing') {
        try {
            stdout.write(`${formatMissingReport(inspection, args[1])}\n`)
            return 0
        } catch (error) {
            stderr.write(`check-i18n: ${error.message}\n`)
            return 1
        }
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
    } = {}
) {
    try {
        validateLocaleId(localeId)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }

    if (localeId === SOURCE_LOCALE) {
        stderr.write(
            `Locale '${SOURCE_LOCALE}' is the English source and is not translated here.\n`
        )
        return 1
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
            { inspection, locale, localePath, stdout },
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

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_LOCALE = 'en'
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
    const pairedKeys = sourceKeys
        .filter((key) => key.endsWith('Single'))
        .map((single) => [single.slice(0, -'Single'.length), single])
        .filter(([plural]) => Object.hasOwn(sourceFlat, plural))
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
                issues,
                translatedKeys: [],
                missingKeys: sourceKeys,
                extraKeys: [],
                translatedCount: 0,
                totalCount: sourceKeys.length,
            })
            continue
        }

        const bundleFlat = flattenBundle(bundle, id, errors, '', issues)
        const translatedKeys = sourceKeys.filter((key) => Object.hasOwn(bundleFlat, key))
        const missingKeys = sourceKeys.filter((key) => !Object.hasOwn(bundleFlat, key))
        const extraKeys = Object.keys(bundleFlat).filter((key) => !Object.hasOwn(sourceFlat, key))

        if (extraKeys.length > 0) {
            errors.push(`'${id}' has key(s) not present in en.json:\n  ${extraKeys.join('\n  ')}`)
            for (const key of extraKeys) {
                issues.push({ type: 'unknown-key', key, localeValue: bundleFlat[key] })
            }
        }

        for (const [plural, single] of pairedKeys) {
            if (Object.hasOwn(bundleFlat, plural) === Object.hasOwn(bundleFlat, single)) continue
            errors.push(`'${id}' must translate '${plural}' and '${single}' together`)
            issues.push({ type: 'plural-pair', plural, single })
        }

        for (const key of translatedKeys) {
            const sourceVars = interpolationVars(sourceFlat[key])
            const localeVars = interpolationVars(bundleFlat[key])
            if (sourceVars.join(',') === localeVars.join(',')) continue
            errors.push(
                `'${id}' key '${key}' has interpolation vars [${localeVars.join(',')}], expected [${sourceVars.join(',')}]`
            )
            issues.push({
                type: 'placeholder',
                key,
                sourceValue: sourceFlat[key],
                localeValue: bundleFlat[key],
                missing: missingVars(sourceVars, localeVars),
                unexpected: missingVars(localeVars, sourceVars),
            })
        }

        locales.push({
            id,
            issues,
            translatedKeys,
            missingKeys,
            extraKeys,
            translatedCount: translatedKeys.length,
            totalCount: sourceKeys.length,
        })
    }

    return {
        errors,
        locales,
        sourceErrors,
        sourceLocale: SOURCE_LOCALE,
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

export function runCheckI18n(
    args,
    { i18nDir = I18N_DIR, stdout = process.stdout, stderr = process.stderr } = {}
) {
    const usage = [
        'Usage: check-i18n.mjs [--status|--missing <locale>|--locale <locale>]',
        '',
        '  no arguments       Validate every locale',
        '  --status           Show all languages and key coverage',
        '  --missing <locale> List missing keys with English source text',
        '  --locale <locale>  Validate one locale with actionable details',
    ].join('\n')
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runCheckI18n(process.argv.slice(2))
}

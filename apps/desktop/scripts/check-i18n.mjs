import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_LOCALE = 'en'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const I18N_DIR = resolve(SCRIPT_DIR, '../src/renderer/src/i18n')

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function flattenBundle(value, localeId, errors, prefix = '') {
    const flat = Object.create(null)
    if (!isPlainObject(value)) {
        errors.push(`'${localeId}' must contain a JSON object`)
        return flat
    }

    for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof child === 'string') {
            if (child.trim().length === 0) errors.push(`'${localeId}' key '${path}' is empty`)
            flat[path] = child
            continue
        }
        if (isPlainObject(child)) {
            Object.assign(flat, flattenBundle(child, localeId, errors, path))
            continue
        }
        errors.push(`'${localeId}' key '${path}' must be a string or object`)
    }
    return flat
}

function interpolationVars(value) {
    return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
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
        throw new Error(`Locale filename '${id}.json' is not a valid BCP 47 language tag`, {
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

    const locales = []
    for (const id of localeIds) {
        if (id === SOURCE_LOCALE) continue

        const bundle = parseBundle(resolve(i18nDir, `${id}.json`), id)
        const bundleFlat = flattenBundle(bundle, id, errors)
        const translatedKeys = sourceKeys.filter((key) => Object.hasOwn(bundleFlat, key))
        const missingKeys = sourceKeys.filter((key) => !Object.hasOwn(bundleFlat, key))
        const extraKeys = Object.keys(bundleFlat).filter((key) => !Object.hasOwn(sourceFlat, key))

        if (extraKeys.length > 0) {
            errors.push(`'${id}' has key(s) not present in en.json:\n  ${extraKeys.join('\n  ')}`)
        }

        for (const [plural, single] of pairedKeys) {
            if (Object.hasOwn(bundleFlat, plural) === Object.hasOwn(bundleFlat, single)) continue
            errors.push(`'${id}' must translate '${plural}' and '${single}' together`)
        }

        for (const key of translatedKeys) {
            const sourceVars = interpolationVars(sourceFlat[key]).join(',')
            const localeVars = interpolationVars(bundleFlat[key]).join(',')
            if (sourceVars === localeVars) continue
            errors.push(
                `'${id}' key '${key}' has interpolation vars [${localeVars}], expected [${sourceVars}]`
            )
        }

        locales.push({
            id,
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

export function formatMissingReport(inspection, localeId) {
    const locale = inspection.locales.find(({ id }) => id === localeId)
    if (!locale) {
        const available = inspection.locales.map(({ id }) => id).join(', ')
        throw new Error(`Unknown translation locale '${localeId}'. Available locales: ${available}`)
    }

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
    let inspection
    try {
        inspection = inspectLocales(i18nDir)
    } catch (error) {
        stderr.write(`check-i18n: ${error.message}\n`)
        return 1
    }

    if (inspection.errors.length > 0) {
        stderr.write(`${validationErrors(inspection)}\n`)
        return 1
    }

    if (args.length === 0) {
        stdout.write(`${formatInspection(inspection)}\n`)
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

    stderr.write('Usage: check-i18n.mjs [--missing <locale>]\n')
    return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runCheckI18n(process.argv.slice(2))
}

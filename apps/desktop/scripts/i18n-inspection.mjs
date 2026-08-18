import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    inspectSourceBundle,
    inspectTranslationBundle,
    singularPluralPairs,
} from './i18n-current.mjs'

export const SOURCE_LOCALE = 'en'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const I18N_DIR = resolve(SCRIPT_DIR, '../src/renderer/src/i18n')

function parseBundle(path, localeId) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`Failed to parse locale '${localeId}' at ${path}`, { cause: error })
    }
}

export function validateLocaleId(id) {
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

export function localeNativeName(localeId) {
    const name = new Intl.DisplayNames([localeId], { type: 'language' }).of(localeId)
    if (!name) throw new Error(`Intl.DisplayNames could not name locale '${localeId}'`)
    return name.charAt(0).toLocaleUpperCase(localeId) + name.slice(1)
}

export function localeEnglishName(localeId) {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(localeId)
    if (!name) throw new Error(`Intl.DisplayNames could not name locale '${localeId}' in English`)
    return name.charAt(0).toUpperCase() + name.slice(1)
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

    const source = parseBundle(resolve(i18nDir, `${SOURCE_LOCALE}.json`), SOURCE_LOCALE)
    const sourceInspection = inspectSourceBundle(source, SOURCE_LOCALE)
    const errors = [...sourceInspection.errors]
    const sourceFlat = sourceInspection.strings
    const sourceKeys = sourceInspection.keys
    const pairedKeys = singularPluralPairs(sourceKeys)
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
                warnings: [],
                reviewNotices: [],
                strings: Object.create(null),
                targetValues: Object.create(null),
                acceptedKeys: [],
                pendingKeys: [],
                pendingPlaceholderIncompatibleKeys: [],
                translatedKeys: [],
                missingKeys: sourceKeys,
                extraKeys: [],
                translatedCount: 0,
                acceptedCount: 0,
                pendingCount: 0,
                pendingPlaceholderIncompatibleCount: 0,
                missingCount: sourceKeys.length,
                totalCount: sourceKeys.length,
            })
            continue
        }

        const locale = { ...inspectTranslationBundle(id, bundle, sourceFlat, sourceKeys), bundle }
        errors.push(...locale.errors)
        locales.push(locale)
    }

    return {
        errors,
        locales,
        sourceErrors,
        sourceIssues: sourceInspection.issues,
        sourceWarnings: sourceInspection.warnings,
        sourceBundle: source,
        sourceLocale: SOURCE_LOCALE,
        pairedKeys,
        sourceKeys,
        sourceStrings: sourceFlat,
        totalCount: sourceKeys.length,
    }
}

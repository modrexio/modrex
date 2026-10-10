import { parseSourceValue, parseTargetValue, usableTargetText } from '../../shared/i18n-values.mts'
import en from './i18n/en.json'
import { LOCALE_IDS, RAW_BUNDLES } from './locales'

type TranslationBundle = { [key: string]: string | TranslationBundle }

export function translationCoverage(source: TranslationBundle, target?: TranslationBundle) {
    let translated = 0
    let total = 0

    for (const [key, value] of Object.entries(source)) {
        const targetValue = target?.[key]
        if (typeof value !== 'string') {
            const nested = translationCoverage(value, targetValue as TranslationBundle | undefined)
            translated += nested.translated
            total += nested.total
            continue
        }

        total++
        if (
            usableTargetText(parseSourceValue(value), parseTargetValue(targetValue)) !== undefined
        ) {
            translated++
        }
    }

    return { translated, total }
}

const sourceTotal = translationCoverage(en).total

export const TRANSLATION_COVERAGE = Object.fromEntries(
    LOCALE_IDS.map((id) => [
        id,
        id === 'en'
            ? { translated: sourceTotal, total: sourceTotal }
            : translationCoverage(en, RAW_BUNDLES[id] as TranslationBundle),
    ])
)

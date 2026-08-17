import { useSyncExternalStore } from 'react'
import { parseSourceValue, parseTargetValue, resolveTargetValue } from '../../shared/i18n-values.js'
import en from './i18n/en.json'
import { LOCALE_IDS, RAW_BUNDLES, isLocaleId, matchLocale, type LocaleId } from './locales'

type DotPaths<T> = T extends string
    ? never
    : {
          [K in keyof T & string]: T[K] extends string
              ? K
              : T[K] extends object
                ? `${K}.${DotPaths<T[K]>}`
                : never
      }[keyof T & string]

export type StringKey = DotPaths<typeof en>

type DeepPartial<T> = T extends string ? T : { [K in keyof T]?: DeepPartial<T[K]> }

type LocaleBundle = DeepPartial<typeof en>

// RAW_BUNDLES is discovered at build time via import.meta.glob, so pnpm check-i18n
// validates each translated subset against en.json before it reaches the app.
const BUNDLES = RAW_BUNDLES as Record<LocaleId, LocaleBundle>

const LOCALE_STORAGE_KEY = 'modrex:locale'

function detectLocale(): LocaleId {
    if (typeof localStorage === 'undefined') return 'en'

    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocaleId(saved)) return saved

    if (typeof navigator === 'undefined') return 'en'

    for (const lang of navigator.languages ?? [navigator.language]) {
        const locale = matchLocale(lang, LOCALE_IDS)
        if (locale) return locale
    }

    return 'en'
}

let activeLocale: LocaleId = detectLocale()
const listeners = new Set<() => void>()

export function getLocale(): LocaleId {
    return activeLocale
}

export function setLocale(id: LocaleId): void {
    if (id === activeLocale) return
    activeLocale = id
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, id)
    for (const listener of listeners) listener()
}

export function subscribeLocale(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

export function useLocale(): LocaleId {
    return useSyncExternalStore(subscribeLocale, getLocale)
}

export { LOCALE_IDS }

function bundleValue(bundle: unknown, parts: readonly string[]): string | undefined {
    let value = bundle
    for (const part of parts) {
        if (typeof value !== 'object' || value === null) return undefined
        value = (value as Record<string, unknown>)[part]
    }
    return typeof value === 'string' ? value : undefined
}

function get(key: StringKey): string {
    const parts = (key as string).split('.')
    const sourceText = bundleValue(en, parts)
    if (sourceText === undefined) return key
    if (activeLocale === 'en') return sourceText

    const storedTarget = bundleValue(BUNDLES[activeLocale], parts)
    return resolveTargetValue(parseSourceValue(sourceText), parseTargetValue(storedTarget))
}

export function t(key: StringKey, vars?: Record<string, string | number>): string {
    const value = get(key)
    if (!vars) return value
    return value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

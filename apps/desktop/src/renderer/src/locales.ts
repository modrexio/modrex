// Locale ids are discovered from the files in i18n/ rather than declared in a manual
// registry, so adding a language is exactly one new JSON file, with no list to edit and
// forget. Native display names come from Intl.DisplayNames (built into every modern
// webview) instead of a hand-maintained label, so there is nothing to keep in sync there
// either.

export type LocaleId = string

const modules = import.meta.glob<Record<string, unknown>>('./i18n/*.json', {
    eager: true,
    import: 'default',
})

function idFromPath(path: string): LocaleId {
    const match = path.match(/\/i18n\/(.+)\.json$/)
    if (!match) throw new Error(`Unexpected locale file path: ${path}`)
    return match[1]
}

export const RAW_BUNDLES: Record<LocaleId, Record<string, unknown>> = Object.fromEntries(
    Object.entries(modules).map(([path, mod]) => [idFromPath(path), mod])
)

export const LOCALE_IDS: LocaleId[] = Object.keys(RAW_BUNDLES).sort((a, b) => {
    if (a === 'en') return -1
    if (b === 'en') return 1
    return a.localeCompare(b)
})

export function isLocaleId(value: string | null): value is LocaleId {
    return value !== null && LOCALE_IDS.includes(value)
}

export function matchLocale(value: string, available: readonly LocaleId[]): LocaleId | null {
    let candidate: string
    try {
        candidate = Intl.getCanonicalLocales(value)[0]
    } catch {
        return null
    }

    while (candidate) {
        if (available.includes(candidate)) return candidate

        const separator = candidate.lastIndexOf('-')
        if (separator === -1) return null
        candidate = candidate.slice(0, separator)

        const trailingSubtag = candidate.slice(candidate.lastIndexOf('-') + 1)
        if (trailingSubtag.length === 1) {
            candidate = candidate.slice(0, candidate.lastIndexOf('-'))
        }
    }

    return null
}

export function localeNativeName(id: LocaleId): string {
    let name: string
    try {
        name = new Intl.DisplayNames([id], { type: 'language' }).of(id) ?? id
    } catch {
        return id
    }
    // Some languages (e.g. Russian) don't capitalize their own name in running text, but
    // every language picker (Windows, Android, this app's own reference points) shows each
    // entry capitalized as a label, which is a UI convention, not a grammar rule.
    return name.charAt(0).toLocaleUpperCase(id) + name.slice(1)
}

export function localeLabel(id: LocaleId): string {
    return `${id.toUpperCase()}  ${localeNativeName(id)}`
}

import { api } from '../../api'
import type { LocaleId } from '../../locales'
import type { GameId } from '../../../../shared/types'

// Backend-neutral event catalog. Call-sites use these typed helpers and never
// touch api.trackEvent directly, so the property shapes stay consistent and the
// underlying sink (currently GA4, in Rust) can be swapped without touching them.

type Params = Record<string, string | number | boolean>

function track(name: string, params?: Params): void {
    void api.trackEvent(name, params)
}

/** A search the user ran on the Browse page. The raw query text is never sent,
 *  only its length and how many results it returned. */
export function trackSearch(game: GameId, queryLength: number, resultCount: number): void {
    track('search_performed', { game, query_length: queryLength, result_count: resultCount })
}

/** A discrete feature the user invoked (e.g. opened docs, switched view mode). */
export function trackFeatureUsed(game: GameId, feature: string): void {
    track('feature_used', { game, feature })
}

export interface ModIdentificationCounts {
    total: number
    identified: number
    unidentified: number
}

/** How many installed mods the index pipeline could identify, which is modrex's core
 *  coverage signal. Counts only, no mod names or hashes. */
export function trackModIdentification(game: GameId, counts: ModIdentificationCounts): void {
    track('mod_identification', {
        game,
        total: counts.total,
        identified: counts.identified,
        unidentified: counts.unidentified,
    })
}

/** The language Modrex is shown in and the system's own language setting. Rust attaches
 *  them to later events, only for users whose consent covers language. */
export function reportLanguage(appLocale: LocaleId): void {
    void api.setAnalyticsLanguage(appLocale, navigator.language)
}

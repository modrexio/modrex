import { api, type SourceInfo } from './api'

// Mirrors the Rust source registry (src-tauri/src/commands/sources.rs), which owns which
// sources exist, the games each serves, and the id each knows a game by. Loaded once at
// startup so the lookups below can stay synchronous: they run inside render paths (the
// sidebar decides whether to offer a source while rendering).
let registry: SourceInfo[] = []

// Brand names, deliberately not in en.json: they are proper nouns.
export const SOURCE_LABELS: Record<string, string> = {
    modworkshop: 'ModWorkshop',
    nexus: 'Nexus Mods',
}

export async function loadSourceRegistry(): Promise<void> {
    registry = await api.listSources()
}

/** The sources declared for a game, in registry order. */
export function sourcesForGame(gameId: string): SourceInfo[] {
    return registry.filter((s) => s.games.some((g) => g.gameId === gameId))
}

export function hasSource(gameId: string, sourceId: string): boolean {
    return sourcesForGame(gameId).some((s) => s.id === sourceId)
}

/**
 * What a source calls this game: modworkshop's numeric game id, Nexus's domain slug.
 * Undefined when the source does not serve the game, which is the same signal
 * sourcesForGame reports.
 */
export function nativeIdFor(gameId: string, sourceId: string): string | undefined {
    return registry.find((s) => s.id === sourceId)?.games.find((g) => g.gameId === gameId)?.nativeId
}

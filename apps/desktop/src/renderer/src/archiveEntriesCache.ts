import { GAMES } from '../../shared/types'
import type { GameId } from '../../shared/types'
import { entryFilename } from './hooks/installedUtils'

// Remembers ModWorkshop multi-pak entries by remote file ID, so ManageFilesModal
// can display variants removed from the installed list.

const memory = new Map<string, Record<string, string[]>>()

function storageKeyFor(game: GameId): string {
    return `modrex:${GAMES[game].storageKey}:archive-entries`
}

function load(game: GameId): Record<string, string[]> {
    const key = storageKeyFor(game)
    let map = memory.get(key)
    if (!map) {
        try {
            map = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string[]>
        } catch {
            map = {}
        }
        memory.set(key, map)
    }
    return map
}

export function getArchiveEntries(game: GameId, fileId: number): string[] | null {
    return load(game)[String(fileId)] ?? null
}

export function setArchiveEntries(game: GameId, fileId: number, entries: string[]): void {
    const map = load(game)
    map[String(fileId)] = entries
    try {
        localStorage.setItem(storageKeyFor(game), JSON.stringify(map))
    } catch {
        // localStorage unavailable or full. The in-memory copy still serves this session.
    }
}

// Union by entry filename, which lets currently-installed files seed the cache without
// clobbering richer entry paths recorded from the archive itself.
export function mergeArchiveEntries(game: GameId, fileId: number, entries: string[]): void {
    const existing = getArchiveEntries(game, fileId) ?? []
    const known = new Set(existing.map((e) => entryFilename(e).toLowerCase()))
    const added = entries.filter((e) => !known.has(entryFilename(e).toLowerCase()))
    if (added.length === 0 && existing.length > 0) return
    setArchiveEntries(game, fileId, [...existing, ...added])
}

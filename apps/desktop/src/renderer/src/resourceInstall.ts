import type { ResourceReview } from './api'

type PendingReview = { handle: string; resolve: (installed: boolean) => void }
const queue: PendingReview[] = []
const listeners = new Set<() => void>()

export function requestResourceReview(handle: string): Promise<boolean> {
    return new Promise((resolve) => {
        queue.push({ handle, resolve })
        for (const listener of listeners) listener()
    })
}

export function subscribeResourceReview(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getPendingResourceReview(): string | null {
    return queue[0]?.handle ?? null
}

export function finishResourceReview(handle: string, installed: boolean): void {
    if (queue[0]?.handle !== handle) throw new Error('Resource review order changed.')
    const pending = queue.shift()!
    pending.resolve(installed)
    for (const listener of listeners) listener()
}

export function resourceSelectionValid(
    review: ResourceReview,
    selection: Record<string, string | null>
): boolean {
    const selected = review.entries.filter((entry) => entry.entryId in selection)
    if (selected.length !== Object.keys(selection).length) return false
    if (selected.length === 0 || selected.some((entry) => !entry.supported)) return false
    const movies = selected.filter((entry) => entry.kind === 'movie')
    if (review.moviePackApplied && movies.length > 0) return false
    const slots = movies.map((entry) => selection[entry.entryId])
    if (slots.some((slot) => !slot || !review.movieSlots.includes(slot))) return false
    if (new Set(slots).size !== slots.length) return false
    return selected.filter((entry) => entry.kind === 'ini').length <= 1
}

function sameIniName(left: string, right: string): boolean {
    const lower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    return lower(left) === lower(right)
}

export function resourceConflicts(
    review: ResourceReview,
    selection: Record<string, string | null>
) {
    const selected = review.entries.filter((entry) => entry.entryId in selection)
    const slots = selected
        .filter((entry) => entry.kind === 'movie')
        .map((entry) => selection[entry.entryId])
    const ini = selected.find((entry) => entry.kind === 'ini')
    return {
        movies: review.movieConflicts
            .filter(
                (pack) =>
                    slots.length > 0 &&
                    (pack.replacing || pack.slots.some((slot) => slots.includes(slot)))
            )
            .map((pack) => ({
                name: pack.name,
                restoredSlots: pack.slots.filter((slot) => !slots.includes(slot)),
            })),
        presets: ini
            ? review.iniConflicts
                  .filter(
                      (preset) =>
                          preset.replacing ||
                          preset.changes.some((change) =>
                              ini.keys.some(
                                  (key) =>
                                      sameIniName(key.section, change.section) &&
                                      sameIniName(key.key, change.key)
                              )
                          )
                  )
                  .map((preset) => ({
                      name: preset.name,
                      restoredKeys: preset.changes.filter(
                          (change) =>
                              !ini.keys.some(
                                  (key) =>
                                      sameIniName(key.section, change.section) &&
                                      sameIniName(key.key, change.key)
                              )
                      ),
                  }))
            : [],
    }
}

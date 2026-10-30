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
    return resourceSelectionIssue(review, selection) === null
}

export function resourceSelectionIssue(
    review: ResourceReview,
    selection: Record<string, string | null>
):
    | 'chooseFiles'
    | 'reviewChanged'
    | 'unsupported'
    | 'chooseMovie'
    | 'duplicateMovie'
    | 'chooseConfig'
    | null {
    const selected = review.entries.filter((entry) => entry.entryId in selection)
    if (selected.length !== Object.keys(selection).length) return 'reviewChanged'
    if (selected.length === 0) return 'chooseFiles'
    const ini = selected.filter((entry) => entry.kind === 'ini')
    if (ini.length > 0 && !review.configPath) return 'chooseConfig'
    if (selected.some((entry) => !entry.supported)) return 'unsupported'
    const movies = selected.filter((entry) => entry.kind === 'movie')
    if (review.moviePackApplied && movies.length > 0) return 'reviewChanged'
    const slots = movies.map((entry) => selection[entry.entryId])
    if (slots.some((slot) => !slot || !review.movieSlots.includes(slot))) return 'chooseMovie'
    if (new Set(slots).size !== slots.length) return 'duplicateMovie'
    if (ini.length > 1) return 'reviewChanged'
    return null
}

export function matchingMovieSlot(
    review: ResourceReview,
    entry: ResourceReview['entries'][number]
): string | null {
    if (entry.kind !== 'movie' || !entry.supported) return null
    const name = entry.name.split(/[\\/]/).at(-1)
    const slots = review.movieSlots.filter((slot) => slot === name)
    const sources = review.entries.filter(
        (candidate) => candidate.kind === 'movie' && candidate.name.split(/[\\/]/).at(-1) === name
    )
    return slots.length === 1 && sources.length === 1 ? slots[0]! : null
}

function movieExtension(name: string): string {
    const file = name.split(/[\\/]/).at(-1)!
    return file.slice(file.lastIndexOf('.') + 1).toLowerCase()
}

// A payload replaces only a movie of its own format, which the backend enforces too.
export function movieSlotsFor(
    review: ResourceReview,
    entry: ResourceReview['entries'][number]
): string[] {
    const extension = movieExtension(entry.name)
    return review.movieSlots.filter((slot) => movieExtension(slot) === extension)
}

// Variants without an exact match stay unselected, since they compete for the same slot.
// A lone movie starts selected even without a match so its destination choice is in view.
export function initialResourceSelection(review: ResourceReview): Record<string, string | null> {
    if (review.moviePackApplied) return {}
    const movies = review.entries.filter((entry) => entry.kind === 'movie' && entry.supported)
    if (movies.length === 1) return { [movies[0]!.entryId]: matchingMovieSlot(review, movies[0]!) }
    const selection: Record<string, string | null> = {}
    for (const movie of movies) {
        const slot = matchingMovieSlot(review, movie)
        if (slot) selection[movie.entryId] = slot
    }
    return selection
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

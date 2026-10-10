import type { GameSpec } from '@modrex/games'
import { extractContentEntries, type ContentEntry } from './content-archive.js'
import {
    MARKER_EXTRACTION_POLICY,
    UNREAL_EXTRACTION_POLICY,
    type DownloadableInput,
    type ExtractionPolicy,
} from './downloadable-state.js'
import {
    downloadArchive,
    extractMarkerEntry,
    extractPdmodEntry,
    UnusableDownloadError,
} from './marker-archive.js'
import { isResourceName, type ResourceMetadata } from './unreal-resource.js'

function collectsResource(game: GameSpec, kind: ResourceMetadata['kind']): boolean {
    return kind === 'movie' ? !!game.movieReplacement : !!game.configPresets
}

export function extractionPolicy(game: GameSpec): ExtractionPolicy {
    const marker = game.modMetadata === 'diesel'
    const base = marker ? MARKER_EXTRACTION_POLICY : 'content-v1'
    if (!game.movieReplacement && !game.configPresets) return base
    if (game.movieReplacement && game.configPresets) {
        return marker ? `${base}-resources-movie-config-v1` : UNREAL_EXTRACTION_POLICY
    }
    return `${base}-resources-${game.movieReplacement ? 'movie' : 'config'}-v1`
}

function storageObjectName(url: string): string {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
}

function advertisedResourceKind(input: DownloadableInput): ResourceMetadata['kind'] | undefined {
    const type = input.mediaType?.toLowerCase()
    if (type === 'bk2') return 'movie'
    if (type === 'ini') return 'config'
    return undefined
}

export function isLooseResource(game: GameSpec, input: DownloadableInput): boolean {
    if (input.kind === 'link' || (!game.movieReplacement && !game.configPresets)) return false
    const advertised = advertisedResourceKind(input)
    if (advertised && collectsResource(game, advertised)) return true
    function matches(name: string | null): boolean {
        if (!name || !isResourceName(name)) return false
        return collectsResource(game, name.toLowerCase().endsWith('.bk2') ? 'movie' : 'config')
    }
    return matches(input.sourceFilename) || matches(storageObjectName(input.url))
}

export async function extractEntries(
    game: GameSpec,
    input: DownloadableInput
): Promise<ContentEntry[]> {
    const marker = game.modMetadata === 'diesel'
    const isPdmod =
        input.mediaType?.toLowerCase() === 'pdmod' ||
        new URL(input.url).pathname.toLowerCase().endsWith('.pdmod')
    if (marker && isPdmod) {
        const entry = await extractPdmodEntry(input.url)
        return entry ? [entry] : []
    }
    const entries: ContentEntry[] = []
    if (marker && !isLooseResource(game, input)) {
        const entry = await extractMarkerEntry(input.url, null)
        if (entry) entries.push(entry)
    }
    // External links retain the bounded marker extractor, even when a game declares resources.
    if (marker && (input.kind === 'link' || (!game.movieReplacement && !game.configPresets)))
        return entries
    const archive = await downloadArchive(input.url)
    if (!archive) throw new UnusableDownloadError('download returned 404')
    const content = extractContentEntries(archive, {
        objectName: storageObjectName(input.url),
        sourceFilename: input.sourceFilename,
        advertisedKind: advertisedResourceKind(input),
    })
    return entries.concat(
        content.filter((entry) =>
            entry.resource ? collectsResource(game, entry.resource.kind) : !marker
        )
    )
}

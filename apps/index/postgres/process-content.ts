import { GAME_IDS, GAMES, isGameId } from '@modrex/games'
import { extractEntries, extractionPolicy, isLooseResource } from './content-extraction.js'
import { TransientFetchError, UnusableDownloadError } from './marker-archive.js'
import { connectDatabase } from './database.js'
import { refreshContentVersions, selectContentListings } from './content-selection.js'
import {
    deferDownloadable,
    finishDiscovery,
    needsProcessing,
    recordHostedVersion,
    registerDownloadable,
    retireMissingDownloadables,
    settleDownloadable,
    type DownloadableInput,
    type DownloadableState,
    type Listing,
} from './downloadable-state.js'
import {
    ModWorkshop,
    ModWorkshopApiError,
    hostedSourceFilename,
    type ModFile,
    type ModLink,
} from './modworkshop.js'

const game = process.argv.find((argument) => argument.startsWith('--game='))?.slice(7) ?? null
if (!isGameId(game)) {
    throw new Error(`--game must be one of ${GAME_IDS.join(', ')}`)
}
const gameSpec = GAMES[game]
if (gameSpec.workshopId === undefined) throw new Error(`${game} has no ModWorkshop binding`)
const limit = Number(
    process.argv.find((argument) => argument.startsWith('--limit='))?.slice(8) ?? '25'
)
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be an integer from 1 through 1000')
}

const db = connectDatabase()
const api = new ModWorkshop()
const policy = extractionPolicy(gameSpec)
const now = new Date()

function shouldDownload(type: string): boolean {
    const normalized = type.toLowerCase()
    return (
        normalized.includes('pak') ||
        normalized.includes('zip') ||
        normalized.includes('7z') ||
        normalized.includes('rar') ||
        normalized === 'pdmod' ||
        normalized === 'application/octet-stream' ||
        normalized === 'application/zip' ||
        normalized === ''
    )
}

function isFetchableUrl(url: string): boolean {
    try {
        const { protocol } = new URL(url)
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}

const listings = await selectContentListings(db, game, limit, now)
const versionRefresh = await refreshContentVersions(db, api, listings, now)

function fileInput(file: ModFile): DownloadableInput {
    return {
        policy,
        kind: 'file',
        remoteId: file.id,
        url: file.download_url,
        version: file.version,
        objectKey: file.file,
        size: file.size,
        mediaType: file.type,
        sourceFilename: hostedSourceFilename(file),
    }
}
function linkInput(link: ModLink): DownloadableInput {
    return {
        policy,
        kind: 'link',
        remoteId: link.id,
        url: link.url,
        version: link.version,
        objectKey: null,
        size: null,
        mediaType: null,
        sourceFilename: null,
    }
}

async function processDownloadable(
    listing: Listing,
    state: DownloadableState
): Promise<{ indexed: boolean; pending: boolean }> {
    if (!needsProcessing(state, now)) {
        await recordHostedVersion(db, listing, state, now)
        return { indexed: state.has_entries, pending: false }
    }
    // ModWorkshop lists abandoned uploads from before its completed flag existed with an
    // empty file key and a download_url that points at the bucket directory.
    if (state.input.kind === 'file' && !state.input.objectKey) {
        await settleDownloadable(db, listing, state, 'unusable', [], now, 'upload never completed')
        return { indexed: false, pending: false }
    }
    if (!shouldDownload(state.input.mediaType ?? '') && !isLooseResource(gameSpec, state.input)) {
        await settleDownloadable(
            db,
            listing,
            state,
            'unusable',
            [],
            now,
            `unsupported media type: ${state.input.mediaType}`
        )
        return { indexed: false, pending: false }
    }
    try {
        const entries = await extractEntries(gameSpec, state.input)
        await settleDownloadable(
            db,
            listing,
            state,
            entries.length ? 'complete' : 'empty',
            entries,
            now
        )
        return { indexed: entries.length > 0, pending: false }
    } catch (error) {
        const subject = `${game} mod ${listing.remote_id} ${state.input.kind} ${state.input.remoteId}`
        if (error instanceof TransientFetchError) {
            console.warn(`${subject} deferred: ${error.message}`)
            await deferDownloadable(db, state, now, error.message)
            return { indexed: false, pending: true }
        }
        if (error instanceof UnusableDownloadError) {
            console.warn(`${subject} has nothing to index: ${error.message}`)
            await settleDownloadable(db, listing, state, 'unusable', [], now, error.message)
            return { indexed: false, pending: false }
        }
        throw error
    }
}

let indexed = 0
let deferred = 0
let downloaded = 0
let skipped = 0
for (const listing of versionRefresh.processable) {
    let files: ModFile[]
    try {
        files = await api.files(listing.remote_id)
    } catch (error) {
        if (error instanceof ModWorkshopApiError && error.status === 404) {
            await retireMissingDownloadables(db, listing, 'file', [], now)
            await retireMissingDownloadables(db, listing, 'link', [], now)
            await finishDiscovery(db, listing, [], false, now)
            continue
        }
        throw error
    }

    const settledIds: number[] = []
    let hasIndexedContent = false
    let pending = false
    for (const file of files) {
        const state = await registerDownloadable(db, listing, fileInput(file), now)
        const processing = needsProcessing(state, now)
        const result = await processDownloadable(listing, state)
        if (processing) downloaded++
        else skipped++
        pending ||= result.pending
        hasIndexedContent ||= result.indexed
        if (result.indexed) settledIds.push(file.id)
    }
    await retireMissingDownloadables(
        db,
        listing,
        'file',
        files.map((file) => file.id),
        now
    )

    let fetchableLinkCount = 0
    if (gameSpec.modMetadata === 'diesel') {
        const links = await api.links(listing.remote_id)
        const fetchableLinks = links.filter((item) => isFetchableUrl(item.url))
        fetchableLinkCount = fetchableLinks.length
        for (const link of fetchableLinks) {
            const state = await registerDownloadable(db, listing, linkInput(link), now)
            const processing = needsProcessing(state, now)
            const result = await processDownloadable(listing, state)
            if (processing) downloaded++
            else skipped++
            pending ||= result.pending
            hasIndexedContent ||= result.indexed
            if (result.indexed) settledIds.push(-link.id)
        }
        await retireMissingDownloadables(
            db,
            listing,
            'link',
            fetchableLinks.map((link) => link.id),
            now
        )
    }

    await finishDiscovery(db, listing, settledIds, files.length > 0 || fetchableLinkCount > 0, now)
    if (pending) deferred++
    else if (hasIndexedContent) indexed++
}

console.log(
    `Processed ${versionRefresh.processable.length} ${game} listings: ${indexed} indexed, ` +
        `${versionRefresh.processable.length - indexed - deferred} with nothing to index, ` +
        `${deferred} deferred; ` +
        `${downloaded} downloadables processed, ${skipped} unchanged`
)
console.log(`ModWorkshop requests: ${api.counts.requests}, retries: ${api.counts.retries}`)
console.log(
    `Reconciled versions: ${versionRefresh.updated} updated, ` +
        `${versionRefresh.missing} missing, ${versionRefresh.failed} failed`
)

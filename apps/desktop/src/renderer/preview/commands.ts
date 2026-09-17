import { GAMES, isGameId, type GameId } from '@modrex/games'
import { commands as real } from '../../shared/bindings'
import type {
    FilePage,
    GameSettings_Serialize,
    LinkPage,
    LoaderInfo,
    LoaderPresence,
    ModDetail,
    ModFolderInfo,
    ModPage,
    NewsResult,
    SisrStatus,
    SourceInfo,
} from '../../shared/bindings'
import { installedFromWorkshop, library, simulateDownload } from './library'
import { previewState, remote } from './previewState'
import loaders from './fixtures/loaders.json'
import sources from './fixtures/sources.json'

type Commands = typeof real

type ModRecord = { detail: ModDetail; files: FilePage; links: LinkPage }

type GameFixtures = {
    modFolders: ModFolderInfo[]
    mods: ModPage
    modRecords: Record<string, ModRecord>
    categories: unknown
    tags: unknown
    news: NewsResult | null
    withoutSmallVariant: Set<string>
}

// Rust's get_thumbnail falls back to the original when the CDN has no thumbnail_ file.
// The browser can only know that from what the catalog says about each image.
function withoutSmallVariant(mods: ModPage, records: Record<string, ModRecord>): Set<string> {
    const files = new Set<string>()
    const note = (image: { file: string; has_thumb: boolean | null } | null) => {
        if (image && image.has_thumb !== true) files.add(image.file)
    }
    for (const mod of mods.data) note(mod.thumbnail)
    for (const { detail } of Object.values(records)) {
        note(detail.thumbnail)
        note(detail.banner)
        detail.images.forEach(note)
    }
    return files
}

const STEAM_COMMON = 'C:\\Program Files (x86)\\Steam\\steamapps\\common'

const steamFolders: Record<GameId, string> = {
    pd3: 'PAYDAY 3',
    pd2: 'PAYDAY 2',
    pdth: 'PAYDAY The Heist',
    cb: 'Crime Boss Rockay City',
    raid: 'RAID World War II',
}

const fixtures = new Map<GameId, Promise<GameFixtures>>()

function game(gameId: string): GameId {
    if (!isGameId(gameId)) throw new Error(`preview: unknown game ${gameId}`)
    return gameId
}

function gameForWorkshop(workshopId: number): GameId {
    const entry = Object.entries(GAMES).find(([, spec]) => spec.workshopId === workshopId)
    if (!entry) throw new Error(`preview: no game for modworkshop id ${workshopId}`)
    return entry[0] as GameId
}

function load(gameId: GameId): Promise<GameFixtures> {
    const cached = fixtures.get(gameId)
    if (cached) return cached
    const loading = Promise.all([
        import(`./fixtures/${gameId}/mod-folders.json`),
        import(`./fixtures/${gameId}/mods.json`),
        import(`./fixtures/${gameId}/mod-records.json`),
        import(`./fixtures/${gameId}/categories.json`),
        import(`./fixtures/${gameId}/tags.json`),
        GAMES[gameId].hasNews ? import(`./fixtures/${gameId}/news.json`) : null,
    ]).then(([modFolders, mods, modRecords, categories, tags, news]) => ({
        modFolders: modFolders.default,
        mods: mods.default,
        modRecords: modRecords.default,
        categories: categories.default,
        tags: tags.default,
        news: news?.default ?? null,
        withoutSmallVariant: withoutSmallVariant(mods.default, modRecords.default),
    }))
    fixtures.set(gameId, loading)
    return loading
}

async function modRecord(modId: number): Promise<ModRecord> {
    const loaded = [...fixtures.keys()]
    const rest = (Object.keys(GAMES) as GameId[]).filter((id) => !fixtures.has(id))
    for (const gameId of [...loaded, ...rest]) {
        const record = (await load(gameId)).modRecords[modId]
        if (record) return record
    }
    throw new Error(`preview: no fixture for mod ${modId}`)
}

async function news(gameId: string, page: number): Promise<NewsResult> {
    const result = (await load(game(gameId))).news
    if (!result) throw new Error(`preview: ${gameId} has no news feed`)
    if (page > 1) throw new Error(`preview: news page ${page} is not snapshotted`)
    return result
}

const gameSettings = new Map<GameId, GameSettings_Serialize>()

function settings(gameId: string): GameSettings_Serialize {
    const id = game(gameId)
    const existing = gameSettings.get(id)
    if (existing) return existing
    const created: GameSettings_Serialize = {
        gamePath: `${STEAM_COMMON}\\${steamFolders[id]}`,
        launcher: 'steam',
        installPinned: false,
        launchOptions: '',
        suppressCrashReporter: false,
        crimebossInstallMode: 'auto',
        loaders: {},
    }
    gameSettings.set(id, created)
    return created
}

function gamePath(gameId: string): string | null {
    return previewState.games === 'missing' ? null : settings(gameId).gamePath
}

const flatSettings = {
    dismissedDepsWarnings: [] as number[],
    skipFileopenlogWarning: false,
}

const sisr: SisrStatus = {
    supported: true,
    installed: false,
    running: false,
    setupComplete: false,
    autoLaunch: false,
}

const noLoader: LoaderPresence = {
    installed: false,
    modworkshopId: null,
    version: null,
    unrecognized: [],
}

const handlers = {
    reportStartupPhase: async () => null,
    getAnalyticsConsent: async () => (previewState.onboarding === 'first-run' ? null : true),
    setAnalyticsConsent: async () => {},
    trackEvent: async () => {},
    setDiscordPresenceEnabled: async () => {},
    updateDiscordPresence: async () => {},
    checkForUpdate: async () => null,
    configureGamePath: async () => null,
    getGameSettings: async (gameId) => ({ ...settings(gameId), gamePath: gamePath(gameId) }),
    getSettings: async () => flatSettings,
    setLaunchOptions: async (gameId, launchOptions) => {
        settings(gameId).launchOptions = launchOptions
    },
    setSuppressCrashReporter: async (gameId, suppress) => {
        settings(gameId).suppressCrashReporter = suppress
    },
    setCrimebossInstallMode: async (mode) => {
        settings('cb').crimebossInstallMode = mode
    },
    setSkipFileopenlogWarning: async (skip) => {
        flatSettings.skipFileopenlogWarning = skip
    },
    dismissDepsWarning: async (modId) => {
        flatSettings.dismissedDepsWarnings.push(modId)
    },
    getSisrStatus: async () => sisr,
    setAutoLaunchSisr: async (enabled) => {
        sisr.autoLaunch = enabled
        return null
    },
    detectedInstalls: async (gameId) => {
        const path = gamePath(gameId)
        return path ? [{ launcher: 'steam', gamePath: path }] : []
    },
    detectInstalledGames: async () => (previewState.games === 'missing' ? [] : Object.keys(GAMES)),
    getInstalled: async (gameId) => {
        const id = game(gameId)
        const lib = library(id)
        if (previewState.library !== 'empty' && !lib.seeded) {
            lib.seed((await load(id)).modRecords, previewState.library)
        }
        return lib.response()
    },
    installMod: async (modId, _gamePath, folderId, gameId) => {
        await remote(`/mods/${modId}`)
        const { detail, files } = await modRecord(modId)
        const file = detail.download ?? files.data[0]
        if (!file) throw new Error(`preview: mod ${modId} has no download`)
        await simulateDownload(`mod:${modId}`, file.size)
        library(game(gameId)).install(installedFromWorkshop(detail, file, folderId))
        return 'installed'
    },
    installFile: async (
        modId,
        _modName,
        fileId,
        _downloadUrl,
        fileType,
        modVersion,
        _gamePath,
        gameId
    ) => {
        const { detail } = await modRecord(modId)
        const file = { id: fileId, version: modVersion, type: fileType, size: null }
        await simulateDownload(`file:${modId}:${fileId}`, file.size)
        library(game(gameId)).install(installedFromWorkshop(detail, file, null))
        return 'installed'
    },
    recordSuccessfulInstall: async () => {},
    uninstallMod: async (_gamePath, uid, gameId) => {
        library(game(gameId)).uninstall(uid)
        return null
    },
    enableMod: async (_gamePath, uid, gameId) => {
        library(game(gameId)).setEnabled(uid, true)
        return null
    },
    disableMod: async (_gamePath, uid, gameId) => {
        library(game(gameId)).setEnabled(uid, false)
        return null
    },
    moveCrimebossModTarget: async (_gamePath, uid) => {
        library('cb').toggleCrimeBossTarget(uid)
        return null
    },
    createFolder: async (_gamePath, displayName, parentId, gameId) =>
        library(game(gameId)).createFolder(displayName, parentId),
    renameFolder: async (_gamePath, folderId, displayName, gameId) => {
        library(game(gameId)).renameFolder(folderId, displayName)
        return null
    },
    deleteFolder: async (_gamePath, folderId, gameId) => {
        library(game(gameId)).deleteFolder(folderId)
        return null
    },
    moveFolder: async (_gamePath, folderId, targetParentId, gameId) => {
        library(game(gameId)).moveFolder(folderId, targetParentId)
        return null
    },
    moveToFolder: async (_gamePath, uid, targetFolderId, targetPosition, gameId) => {
        library(game(gameId)).moveToFolder(uid, targetFolderId, targetPosition)
        return null
    },
    reorderInFolder: async (_gamePath, folderId, orderedUids, gameId) => {
        library(game(gameId)).reorderInFolder(folderId, orderedUids)
        return null
    },
    reorderChildren: async (_gamePath, _parentId, items, gameId) => {
        library(game(gameId)).reorderChildren(items)
        return null
    },
    restoreMods: async () => null,
    listLoaders: async () => loaders as LoaderInfo[],
    listSources: async () => sources as SourceInfo[],
    checkLoader: async () => false,
    ue4ssPresence: async () => noLoader,
    listModFolders: async (gameId) => (await load(game(gameId))).modFolders,
    secretStoreAvailable: async () => true,
    nexusOauthSignedIn: async () => false,
    isGameRunning: async () => false,
    listCategories: async (workshopId) => {
        await remote(`/games/${workshopId}/categories`)
        return (await load(gameForWorkshop(workshopId))).categories
    },
    listTags: async (workshopId) => {
        await remote(`/games/${workshopId}/tags`)
        return (await load(gameForWorkshop(workshopId))).tags
    },
    listMods: async (workshopId, params) => {
        await remote(`/games/${workshopId}/mods`)
        const fixture = await load(gameForWorkshop(workshopId))
        const page = fixture.mods
        const requestedPage = params?.page ?? 1
        if (requestedPage !== 1) {
            throw new Error(`preview: no fixture for mods page ${requestedPage}`)
        }
        const query = params?.query?.toLowerCase()
        const ids = params?.ids
        const categoryId = params?.category_id
        const includedTags = params?.tags
        const blockedTags = params?.block_tags
        const data = page.data.filter((mod) => {
            if (query && !mod.name.toLowerCase().includes(query)) return false
            if (ids && !ids.includes(mod.id)) return false
            if (categoryId != null && mod.category_id !== categoryId) return false
            if (!includedTags?.length && !blockedTags?.length) return true

            const record = fixture.modRecords[String(mod.id)]
            if (!record) throw new Error(`preview: no mod record for ${mod.id}`)
            const tags = new Set(record.detail.tags.map((tag) => tag.id))
            if (includedTags?.length && !includedTags.some((tag) => tags.has(tag))) return false
            if (blockedTags?.some((tag) => tags.has(tag))) return false
            return true
        })

        switch (params?.sort ?? 'bumped_at') {
            case 'bumped_at':
                data.sort((a, b) => Date.parse(b.bumped_at) - Date.parse(a.bumped_at))
                break
            case 'published_at':
                data.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
                break
            case 'downloads':
                data.sort((a, b) => b.downloads - a.downloads)
                break
            case 'likes':
                data.sort((a, b) => b.likes - a.likes)
                break
            case 'name':
                data.sort((a, b) => a.name.localeCompare(b.name))
                break
            default:
                throw new Error(`preview: unsupported mods sort ${params?.sort}`)
        }

        return {
            data,
            meta: { ...page.meta, current_page: 1, last_page: 1, total: data.length },
        }
    },
    getMod: async (id) => {
        await remote(`/mods/${id}`)
        return (await modRecord(id)).detail
    },
    listModFiles: async (modId) => {
        await remote(`/mods/${modId}/files`)
        return (await modRecord(modId)).files
    },
    listModLinks: async (modId) => {
        await remote(`/mods/${modId}/links`)
        return (await modRecord(modId)).links
    },
    fetchNews: async (gameId) => {
        await remote(`/news/${gameId}`)
        return news(gameId, 1)
    },
    refreshNews: async (gameId) => {
        await remote(`/news/${gameId}`)
        return news(gameId, 1)
    },
    fetchNewsPage: async (gameId, page) => {
        await remote(`/news/${gameId}/${page}`)
        return news(gameId, page)
    },
    getStorageUsage: async () => ({ thumbnails: 48_300_000, indexDb: 12_900_000, news: 210_000 }),
    getThumbnail: async (filename, full) => {
        if (full) return filename
        for (const loaded of await Promise.all(fixtures.values())) {
            if (loaded.withoutSmallVariant.has(filename)) return filename
        }
        return `thumbnail_${filename}`
    },
    shellOpenExternal: async (url) => {
        window.open(url, '_blank', 'noopener')
    },
} satisfies Partial<Commands>

const unhandled = Object.fromEntries(
    Object.keys(real).map((name) => [
        name,
        () => Promise.reject(new Error(`preview: no handler for command ${name}`)),
    ])
) as unknown as Commands

export const commands: Commands = { ...unhandled, ...handlers }

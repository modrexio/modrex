import { commands as real } from '../../shared/bindings'
import type {
    GameSettings_Serialize,
    InstalledResponse_Serialize,
    LoaderInfo,
    LoaderPresence,
    ModFolderInfo,
    ModPage,
    SourceInfo,
} from '../../shared/bindings'
import loaders from './fixtures/loaders.json'
import sources from './fixtures/sources.json'
import pd3ModFolders from './fixtures/pd3/mod-folders.json'
import pd3Mods from './fixtures/pd3/mods.json'
import pd3Categories from './fixtures/pd3/categories.json'
import pd3Tags from './fixtures/pd3/tags.json'

type Commands = typeof real

const GAME_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3'

const gameSettings: GameSettings_Serialize = {
    gamePath: GAME_PATH,
    launcher: 'steam',
    installPinned: false,
    launchOptions: '',
    suppressCrashReporter: false,
    crimebossInstallMode: 'auto',
    loaders: {},
}

const installed: InstalledResponse_Serialize = {
    mods: [],
    folders: [],
    modsHidden: false,
    stateUnreadable: false,
}

const noLoader: LoaderPresence = {
    installed: false,
    modworkshopId: null,
    version: null,
    unrecognized: [],
}

const games = {
    pd3: {
        workshopId: 853,
        modFolders: pd3ModFolders as ModFolderInfo[],
        mods: pd3Mods as ModPage,
        categories: pd3Categories,
        tags: pd3Tags,
    },
}

function game(gameId: string) {
    const entry = games[gameId as keyof typeof games]
    if (!entry) throw new Error(`preview: no fixtures for game ${gameId}`)
    return entry
}

function workshop(workshopId: number) {
    const entry = Object.values(games).find((g) => g.workshopId === workshopId)
    if (!entry) throw new Error(`preview: no fixtures for modworkshop game ${workshopId}`)
    return entry
}

const handlers = {
    reportStartupPhase: async () => null,
    getAnalyticsConsent: async () => true,
    setAnalyticsConsent: async () => {},
    trackEvent: async () => {},
    setDiscordPresenceEnabled: async () => {},
    updateDiscordPresence: async () => {},
    checkForUpdate: async () => null,
    configureGamePath: async () => null,
    getGameSettings: async () => gameSettings,
    detectedInstalls: async () => [{ launcher: 'steam', gamePath: GAME_PATH }],
    detectInstalledGames: async () => ['pd3'],
    getInstalled: async () => installed,
    listLoaders: async () => loaders as LoaderInfo[],
    listSources: async () => sources as SourceInfo[],
    checkLoader: async () => false,
    ue4ssPresence: async () => noLoader,
    listModFolders: async (gameId) => game(gameId).modFolders,
    secretStoreAvailable: async () => true,
    nexusOauthSignedIn: async () => false,
    isGameRunning: async () => false,
    listCategories: async (gameId) => workshop(gameId).categories,
    listTags: async (gameId) => workshop(gameId).tags,
    listMods: async (gameId, params) => {
        const page = workshop(gameId).mods
        const query = params?.query?.toLowerCase()
        if (!query) return page
        const data = page.data.filter((mod) => mod.name.toLowerCase().includes(query))
        return { data, meta: { ...page.meta, total: data.length, last_page: 1 } }
    },
    getThumbnail: async (filename, full) => (full ? filename : `thumbnail_${filename}`),
} satisfies Partial<Commands>

const unhandled = Object.fromEntries(
    Object.keys(real).map((name) => [
        name,
        () => Promise.reject(new Error(`preview: no handler for command ${name}`)),
    ])
) as unknown as Commands

export const commands: Commands = { ...unhandled, ...handlers }

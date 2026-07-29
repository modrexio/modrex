import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { commands, type InstallOutcome } from '../../shared/bindings'
import type {
    LoaderInfo,
    SourceInfo,
    NexusArchiveIdentity,
    NexusContentIdentifyOutcome,
} from '../../shared/bindings'
export type {
    InstallOutcome,
    LoaderInfo,
    SourceInfo,
    NexusArchiveIdentity,
    NexusHashMatch,
    NexusContentIdentifyOutcome,
} from '../../shared/bindings'

// The library declares this union without exporting it.
export type ResizeDirection = Parameters<
    ReturnType<typeof getCurrentWindow>['startResizeDragging']
>[0]
import type {
    Mod,
    ModSummary,
    ModFile,
    ModLink,
    Category,
    ModTag,
    Paginated,
    InstalledMod,
    ModFolder,
    TopLevelItem,
    ListModsParams,
    IndexModFile,
    NewsResult,
} from '../../shared/types'

export type { StartupPhase } from '../../shared/bindings'
import type { StartupPhase } from '../../shared/bindings'

type Settings = {
    gamePath?: string
    launcher?: string
    launchOptions?: string
    skipFileOpenLogWarning?: boolean
    dismissedDepsWarnings?: number[]
}

export type GameSettings = {
    gamePath?: string
    launcher?: string
    launchOptions?: string
    suppressCrashReporter?: boolean
    // Crime Boss only: 'auto' (default) or 'ask'. Absent behaves as 'auto'.
    crimebossInstallMode?: string
}

// Feeds the one-time "star us on GitHub" prompt (settings.rs::record_successful_install).
// Any real install error suppresses the prompt for this session; a needs-a-decision
// outcome is flow control, not a failure, so it neither counts nor poisons.
let installErrorThisSession = false

async function trackInstall(install: Promise<unknown>): Promise<void> {
    try {
        await install
    } catch (e) {
        installErrorThisSession = true
        throw e
    }
    void commands.recordSuccessfulInstall(!installErrorThisSession)
}

async function trackInstallOutcome(install: Promise<InstallOutcome>): Promise<InstallOutcome> {
    let outcome: InstallOutcome
    try {
        outcome = await install
    } catch (e) {
        installErrorThisSession = true
        throw e
    }
    if (outcome === 'installed') {
        void commands.recordSuccessfulInstall(!installErrorThisSession)
    }
    return outcome
}

function onEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
    let unlistenFn: (() => void) | null = null
    let cancelled = false
    listen<T>(eventName, (event) => callback(event.payload)).then((fn) => {
        if (cancelled) fn()
        else unlistenFn = fn
    })
    return () => {
        cancelled = true
        unlistenFn?.()
    }
}

export const api = {
    // ── Startup ────────────────────────────────────────────────────────────────
    async reportStartupPhase(phase: StartupPhase): Promise<void> {
        await commands.reportStartupPhase(phase)
    },
    getStartupPhase(): Promise<StartupPhase> {
        return commands.getStartupPhase()
    },
    async finishStartup(): Promise<void> {
        await commands.finishStartup()
    },
    onStartupProgress(callback: (phase: StartupPhase) => void): () => void {
        return onEvent<StartupPhase>('startup:progress', callback)
    },

    // ── Browse / API ───────────────────────────────────────────────────────────
    listMods(gameId: number, params?: ListModsParams): Promise<Paginated<ModSummary>> {
        const p = params ?? {}
        return commands.listMods(gameId, {
            query: p.query ?? null,
            limit: p.limit ?? null,
            sort: p.sort ?? null,
            category_id: p.category_id ?? null,
            page: p.page ?? null,
            ids: p.ids ?? null,
            tags: p.tags ?? null,
            block_tags: p.block_tags ?? null,
        })
    },
    listCategories(gameId: number): Promise<Paginated<Category>> {
        return commands.listCategories(gameId) as Promise<Paginated<Category>>
    },
    listTags(gameId: number): Promise<Paginated<ModTag>> {
        return commands.listTags(gameId) as Promise<Paginated<ModTag>>
    },
    getMod(id: number): Promise<Mod> {
        return commands.getMod(id)
    },
    listModFiles(modId: number): Promise<Paginated<ModFile>> {
        return commands.listModFiles(modId)
    },
    listModLinks(modId: number): Promise<Paginated<ModLink>> {
        return commands.listModLinks(modId)
    },

    // ── Settings ───────────────────────────────────────────────────────────────
    getSettings(): Promise<Settings> {
        return commands.getSettings() as Promise<Settings>
    },
    getGameSettings(gameId: string): Promise<GameSettings> {
        return commands.getGameSettings(gameId) as unknown as Promise<GameSettings>
    },
    async findGamePath(gameId: string): Promise<string | null> {
        await commands.configureGamePath(gameId, null)
        const gs = await commands.getGameSettings(gameId)
        return gs.gamePath ?? null
    },
    setGamePath(gamePath: string | null, gameId: string): Promise<void> {
        return commands.configureGamePath(gameId, gamePath)
    },
    setLauncher(launcher: string, gameId: string): Promise<void> {
        return commands.setLauncher(gameId, launcher)
    },
    setLaunchOptions(launchOptions: string, gameId: string): Promise<void> {
        return commands.setLaunchOptions(gameId, launchOptions)
    },
    setCrimeBossInstallMode(mode: string): Promise<void> {
        return commands.setCrimebossInstallMode(mode)
    },
    setSuppressCrashReporter(suppress: boolean, gameId: string): Promise<void> {
        return commands.setSuppressCrashReporter(gameId, suppress)
    },
    setSkipFileOpenLogWarning(skip: boolean): Promise<void> {
        return commands.setSkipFileopenlogWarning(skip)
    },
    dismissDepsWarning(modId: number): Promise<void> {
        return commands.dismissDepsWarning(modId)
    },
    pickFolder(defaultPath?: string): Promise<string | null> {
        return commands.pickFolder(defaultPath ?? null)
    },
    openLog(): Promise<void> {
        return commands.openLogFile()
    },
    openDataFolder(): Promise<void> {
        return commands.openDataFolder()
    },
    openAppFolder(): Promise<void> {
        return commands.openAppFolder()
    },

    // ── Storage / data management ─────────────────────────────────────────────
    // Cache sizes/clears are in bytes; clear commands return the bytes freed.
    getStorageUsage(): Promise<{ thumbnails: number; indexDb: number; news: number }> {
        return commands.getStorageUsage()
    },
    clearThumbnailCache(): Promise<number> {
        return commands.clearThumbnailCache()
    },
    clearIndexCache(): Promise<number> {
        return commands.clearIndexCache()
    },
    clearNewsCache(): Promise<number> {
        return commands.clearNewsCache()
    },
    resetAppSettings(): Promise<void> {
        return commands.resetAppSettings()
    },

    // Nexus
    // OAuth2 PKCE sign-in: opens the browser to users.nexusmods.com; the result
    // comes back asynchronously via the nexus-oauth:signed-in / failed events.
    nexusOAuthStart(): Promise<void> {
        return commands.nexusOauthStart()
    },
    isNexusSignedIn(): Promise<boolean> {
        return commands.nexusOauthSignedIn()
    },
    nexusSignOut(): Promise<void> {
        return commands.nexusOauthSignOut()
    },
    // Whether the OS credential store (Windows Credential Manager / Linux Secret
    // Service) is currently usable — not Nexus-specific, but Nexus sign-in is the one
    // feature today that needs it, so this is what gates the Settings warning banner.
    secretStoreAvailable(): Promise<boolean> {
        return commands.secretStoreAvailable()
    },
    // GraphQL v2 search, verified live via schema introspection. Empty query omits
    // the name filter (browse-by-sort instead of search). sort is one of
    // "relevance" | "downloads" | "endorsements" | "updatedAt".
    nexusSearchMods(
        gameId: string,
        query: string,
        sort: string,
        offset?: number
    ): Promise<Paginated<ModSummary>> {
        return commands.nexusSearchMods(gameId, query, sort, offset ?? null)
    },
    // REST v1 /mods/{id}.json, mapped onto the same Mod shape modworkshop's getMod
    // returns. Unlike nexusSearchMods, this carries a real version.
    nexusGetModDetail(gameId: string, modId: number): Promise<Mod> {
        return commands.nexusGetModDetail(gameId, modId)
    },
    // REST v1 /mods/{id}/files.json. Files carry no direct download_url for a free
    // account, only a per-file link to the Nexus site's Mod Manager Download button.
    nexusListModFiles(gameId: string, modId: number): Promise<Paginated<ModFile>> {
        return commands.nexusListModFiles(gameId, modId)
    },
    // Archive-level MD5 lookup for a dropped file, ahead of installDroppedFile. A
    // notFound or ambiguous result is not an error - the caller falls through to
    // the existing unidentified install path either way.
    identifyDroppedArchive(gameId: string, path: string): Promise<NexusArchiveIdentity> {
        return commands.identifyDroppedArchive(gameId, path)
    },

    // ── Analytics ────────────────────────────────────────────────────────────────
    // Fire-and-forget: the Rust side gates on consent and swallows errors, so callers
    // never need to await or catch.
    trackEvent(name: string, params?: Record<string, string | number | boolean>): Promise<void> {
        return commands.trackEvent(name, params ?? {})
    },
    // null = the user hasn't been asked yet (show the first-run consent dialog).
    getAnalyticsConsent(): Promise<boolean | null> {
        return commands.getAnalyticsConsent()
    },
    setAnalyticsConsent(enabled: boolean): Promise<void> {
        return commands.setAnalyticsConsent(enabled)
    },
    setDiscordPresenceEnabled(enabled: boolean): Promise<void> {
        return commands.setDiscordPresenceEnabled(enabled)
    },
    updateDiscordPresence(game: string): Promise<void> {
        return commands.updateDiscordPresence(game)
    },

    // ── Installed mods ─────────────────────────────────────────────────────────
    getInstalled(
        gameId: string
    ): Promise<{ mods: InstalledMod[]; folders: ModFolder[]; modsHidden: boolean }> {
        return commands.getInstalled(gameId) as unknown as Promise<{
            mods: InstalledMod[]
            folders: ModFolder[]
            modsHidden: boolean
        }>
    },
    async openModsFolder(gameId: string): Promise<void> {
        await commands.openModsFolder(gameId)
    },
    listModFolders(gameId: string): Promise<{ tag: string; labelKey: string }[]> {
        return commands.listModFolders(gameId)
    },
    async openModFolder(gameId: string, tag: string): Promise<void> {
        await commands.openModFolder(gameId, tag)
    },
    installMod(modId: number, gamePath: string, gameId: string): Promise<InstallOutcome> {
        return trackInstallOutcome(commands.installMod(modId, gamePath, null, gameId))
    },
    installDroppedFile(
        path: string,
        gamePath: string,
        gameId: string,
        folderId?: string
    ): Promise<InstallOutcome> {
        return trackInstallOutcome(
            commands.installDroppedFile(path, gamePath, folderId ?? null, gameId)
        )
    },
    installModFile(
        modId: number,
        modName: string,
        fileId: number,
        downloadUrl: string,
        fileType: string,
        modVersion: string,
        gamePath: string,
        gameId: string
    ): Promise<InstallOutcome> {
        return trackInstallOutcome(
            commands.installFile(
                modId,
                modName,
                fileId,
                downloadUrl,
                fileType,
                modVersion,
                gamePath,
                gameId
            )
        )
    },
    deleteTempFile(path: string): Promise<void> {
        return commands.deleteTempFile(path)
    },
    getIndexModFiles(modId: number, gameId: string): Promise<IndexModFile[]> {
        return commands.getIndexModFiles(modId, gameId)
    },

    // ── News ───────────────────────────────────────────────────────────────────
    fetchNews(gameId: string): Promise<NewsResult> {
        return commands.fetchNews(gameId)
    },
    refreshNews(gameId: string): Promise<NewsResult> {
        return commands.refreshNews(gameId)
    },
    fetchNewsPage(gameId: string, page: number): Promise<NewsResult> {
        return commands.fetchNewsPage(gameId, page)
    },
    installFromZipEntry(
        zipPath: string,
        entryName: string,
        modId: number,
        modName: string,
        fileId: number,
        fileType: string,
        modVersion: string,
        gamePath: string,
        gameId: string,
        folderId?: string | null,
        locationTag?: string,
        entryKind?: string
    ): Promise<void> {
        return trackInstall(
            commands.installFromZipEntry({
                zipPath,
                entryName,
                modId,
                modName,
                fileId,
                fileType,
                modVersion,
                gamePath,
                folderId: folderId ?? null,
                gameId,
                locationTag: locationTag ?? null,
                entryKind: entryKind ?? null,
            })
        )
    },
    installCbFlatArchive(
        zipPath: string,
        modId: number,
        modName: string,
        fileId: number,
        fileType: string,
        modVersion: string,
        gamePath: string,
        folderId?: string | null
    ): Promise<void> {
        return trackInstall(
            commands.installCbFlatArchive(
                zipPath,
                modId,
                modName,
                fileId,
                fileType,
                modVersion,
                gamePath,
                folderId ?? null
            )
        )
    },
    installHostPack(
        zipPath: string,
        entryName: string,
        modId: number,
        modName: string,
        fileId: number,
        fileType: string,
        modVersion: string,
        gamePath: string,
        hostModId: number,
        hostSubpath: string,
        gameId: string
    ): Promise<void> {
        return trackInstall(
            commands.installHostPack({
                zipPath,
                entryName,
                modId,
                modName,
                fileId,
                fileType,
                modVersion,
                gamePath,
                hostModId,
                hostSubpath,
                gameId,
            })
        )
    },
    async uninstallMod(uid: string, gamePath: string, gameId: string): Promise<void> {
        await commands.uninstallMod(gamePath, uid, gameId)
    },
    async enableMod(uid: string, gamePath: string, gameId: string): Promise<void> {
        await commands.enableMod(gamePath, uid, gameId)
    },
    async disableMod(uid: string, gamePath: string, gameId: string): Promise<void> {
        await commands.disableMod(gamePath, uid, gameId)
    },
    // Tier 3 identification, gated behind an explicit user action - never call this
    // from a background/automatic refresh. A miss is expected for roughly a quarter
    // of mods and is not an error.
    identifyModViaNexusContent(
        uid: string,
        gamePath: string,
        gameId: string
    ): Promise<NexusContentIdentifyOutcome> {
        return commands.identifyModViaNexusContent(gamePath, uid, gameId)
    },
    async moveCrimeBossModTarget(uid: string, gamePath: string): Promise<void> {
        await commands.moveCrimebossModTarget(gamePath, uid)
    },
    async reorderModsInFolder(
        folderId: string | null,
        orderedUids: string[],
        gamePath: string,
        gameId: string
    ): Promise<void> {
        await commands.reorderInFolder(gamePath, folderId, orderedUids, gameId)
    },
    async moveModToFolder(
        uid: string,
        targetFolderId: string | null,
        targetPosition: number,
        gamePath: string,
        gameId: string
    ): Promise<void> {
        await commands.moveToFolder(gamePath, uid, targetFolderId, targetPosition, gameId)
    },
    async reorderChildren(
        parentId: string | null,
        items: TopLevelItem[],
        gamePath: string,
        gameId: string
    ): Promise<void> {
        await commands.reorderChildren(gamePath, parentId, items, gameId)
    },
    async moveFolder(
        folderId: string,
        targetParentId: string | null,
        gamePath: string,
        gameId: string
    ): Promise<void> {
        await commands.moveFolder(gamePath, folderId, targetParentId, gameId)
    },
    createFolder(
        displayName: string,
        parentId: string | null,
        gamePath: string,
        gameId: string
    ): Promise<ModFolder> {
        return commands.createFolder(gamePath, displayName, parentId, gameId)
    },
    async renameFolder(
        folderId: string,
        displayName: string,
        gamePath: string,
        gameId: string
    ): Promise<void> {
        await commands.renameFolder(gamePath, folderId, displayName, gameId)
    },
    async deleteFolder(folderId: string, gamePath: string, gameId: string): Promise<void> {
        await commands.deleteFolder(gamePath, folderId, gameId)
    },

    isPd2Diesel3(gamePath: string): Promise<boolean> {
        return commands.isPd2Diesel3(gamePath)
    },

    // ── Mod loaders (registry-driven) ──────────────────────────────────────────
    // The registry (src-tauri/src/commands/loaders.rs) owns which loaders exist, the
    // modworkshop ids they are published under, and which games they serve — the
    // renderer reads it instead of restating those tables.
    listLoaders(): Promise<LoaderInfo[]> {
        return commands.listLoaders()
    },
    // The source registry: which sources exist, the games each serves, and the id each
    // knows a game by. Replaces per-source fields on the game spec.
    listSources(): Promise<SourceInfo[]> {
        return commands.listSources()
    },
    checkLoader(loaderId: string, gameId: string, gamePath: string): Promise<boolean> {
        return commands.checkLoader(loaderId, gameId, gamePath)
    },
    async installLoader(loaderId: string, gamePath: string): Promise<void> {
        await commands.installLoader(loaderId, gamePath)
    },

    // ── Launchers & system ─────────────────────────────────────────────────────
    isGameRunning(gameId: string): Promise<boolean> {
        return commands.isGameRunning(gameId)
    },
    async stopGame(gameId: string): Promise<void> {
        await commands.stopGame(gameId)
    },
    async launchModded(gameId: string): Promise<void> {
        await commands.launchGame(gameId)
    },
    async launchWithoutMods(gameId: string): Promise<void> {
        await commands.launchWithoutMods(gameId)
    },
    async restoreMods(gameId: string): Promise<void> {
        await commands.restoreMods(gameId)
    },
    getInstalledLaunchers(gameId: string): Promise<string[]> {
        return commands.installedLaunchers(gameId)
    },
    openExternal(url: string): Promise<void> {
        return commands.shellOpenExternal(url)
    },
    openPath(path: string): Promise<void> {
        return commands.shellOpenPath(path)
    },

    // ── Events ─────────────────────────────────────────────────────────────────
    onDownloadProgress(
        callback: (info: { download_id: string; downloaded: number; total: number }) => void
    ): () => void {
        return onEvent<{ download_id: string; downloaded: number; total: number }>(
            'download:progress',
            callback
        )
    },
    onInstallScan(callback: (info: { phase: string; total: number }) => void): () => void {
        return onEvent<{ phase: string; total: number }>('installed:scan', callback)
    },
    // Fired by the nxm:// handoff as soon as a link is accepted, before any
    // network work, so the UI can react instantly.
    onNxmInstallStarted(
        callback: (info: { gameId: string; modId: number; fileId: number }) => void
    ): () => void {
        return onEvent<{ gameId: string; modId: number; fileId: number }>(
            'nxm:install-started',
            callback
        )
    },
    onNxmInstallComplete(
        callback: (info: { gameId: string; modId: number; fileId: number; name: string }) => void
    ): () => void {
        return onEvent<{ gameId: string; modId: number; fileId: number; name: string }>(
            'nxm:install-complete',
            callback
        )
    },
    onNexusOAuthSignedIn(callback: () => void): () => void {
        return onEvent<null>('nexus-oauth:signed-in', () => callback())
    },
    onNexusOAuthFailed(callback: (error: string) => void): () => void {
        return onEvent<string>('nexus-oauth:failed', callback)
    },
    onNxmInstallFailed(callback: (error: string) => void): () => void {
        return onEvent<string>('nxm:install-failed', callback)
    },
    onUpdateAvailable(
        callback: (info: {
            version: string
            strategy: 'auto' | 'manual' | 'browser'
            body: string
            releaseUrl: string
        }) => void
    ): () => void {
        return onEvent('updater:update-available', callback)
    },
    onUpdateProgress(callback: (percent: number) => void): () => void {
        return onEvent<number>('updater:update-progress', callback)
    },
    onUpdateReady(callback: () => void): () => void {
        return onEvent<void>('updater:update-ready', () => callback())
    },
    onSupportPromptEligible(callback: () => void): () => void {
        return onEvent<void>('support-prompt:eligible', () => callback())
    },
    // Native OS file-drop paths (dragDropEnabled: true). 'enter'/'over' fire while files
    // hover the window; 'drop' delivers the final absolute paths; 'leave' on cancel.
    onFileDrop(
        callback: (info: { type: 'enter' | 'over' | 'drop' | 'leave'; paths: string[] }) => void
    ): () => void {
        let unlistenFn: (() => void) | null = null
        let cancelled = false
        getCurrentWebview()
            .onDragDropEvent((event) => {
                const p = event.payload
                callback({ type: p.type, paths: 'paths' in p ? p.paths : [] })
            })
            .then((fn) => {
                if (cancelled) fn()
                else unlistenFn = fn
            })
        return () => {
            cancelled = true
            unlistenFn?.()
        }
    },

    // ── Thumbnails ─────────────────────────────────────────────────────────────
    getThumbnail(filename: string, full?: boolean): Promise<string> {
        return commands.getThumbnail(filename, full ?? null)
    },

    // ── Updater ────────────────────────────────────────────────────────────────
    async download(): Promise<void> {
        await commands.downloadUpdate()
    },
    async installUpdate(): Promise<void> {
        await commands.installUpdate()
    },
    async checkForUpdates(): Promise<void> {
        await commands.checkForUpdate()
    },

    // ── Window controls (custom title bar) ─────────────────────────────────────
    windowMinimize(): Promise<void> {
        return getCurrentWindow().minimize()
    },
    windowToggleMaximize(): Promise<void> {
        return getCurrentWindow().toggleMaximize()
    },
    windowClose(): Promise<void> {
        return getCurrentWindow().close()
    },
    windowIsMaximized(): Promise<boolean> {
        return getCurrentWindow().isMaximized()
    },
    windowStartResizeDragging(direction: ResizeDirection): Promise<void> {
        return getCurrentWindow().startResizeDragging(direction)
    },
    onWindowResized(callback: () => void): () => void {
        let unlisten: (() => void) | null = null
        let cancelled = false
        getCurrentWindow()
            .onResized(() => callback())
            .then((fn) => {
                if (cancelled) fn()
                else unlisten = fn
            })
        return () => {
            cancelled = true
            unlisten?.()
        }
    },
}

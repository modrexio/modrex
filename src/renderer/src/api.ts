import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'

// The library declares this union without exporting it.
export type ResizeDirection = Parameters<
    ReturnType<typeof getCurrentWindow>['startResizeDragging']
>[0]
import type {
    Mod,
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

export type StartupPhase = 'prepare' | 'interface' | 'game' | 'mods' | 'ready' | 'error'

// Feeds the one-time "star us on GitHub" prompt (settings.rs::record_successful_install).
// Picker sentinels (ZIP_MULTI_PAK etc.) are flow control, not failures, so they don't
// poison the session; any real install error suppresses the prompt for this session.
const INSTALL_SENTINEL_PREFIXES = [
    'ZIP_MULTI_PAK:',
    'HOST_MOD_PACK:',
    'CB_FLAT_ARCHIVE:',
    'UNRECOGNIZED_ARCHIVE',
]

let installErrorThisSession = false

async function trackInstall(install: Promise<void>): Promise<void> {
    try {
        await install
    } catch (e) {
        if (!INSTALL_SENTINEL_PREFIXES.some((p) => String(e).startsWith(p))) {
            installErrorThisSession = true
        }
        throw e
    }
    void invoke('record_successful_install', { cleanSession: !installErrorThisSession })
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
    reportStartupPhase(phase: StartupPhase): Promise<void> {
        return invoke('report_startup_phase', { phase })
    },
    getStartupPhase(): Promise<StartupPhase> {
        return invoke('get_startup_phase')
    },
    finishStartup(): Promise<void> {
        return invoke('finish_startup')
    },
    onStartupProgress(callback: (phase: StartupPhase) => void): () => void {
        return onEvent<StartupPhase>('startup:progress', callback)
    },

    // ── Browse / API ───────────────────────────────────────────────────────────
    listMods(gameId: number, params?: ListModsParams): Promise<Paginated<Mod>> {
        return invoke('list_mods', { gameId, params: params ?? {} })
    },
    listCategories(gameId: number): Promise<Paginated<Category>> {
        return invoke('list_categories', { gameId })
    },
    listTags(gameId: number): Promise<Paginated<ModTag>> {
        return invoke('list_tags', { gameId })
    },
    getMod(id: number): Promise<Mod> {
        return invoke('get_mod', { id })
    },
    listModFiles(modId: number): Promise<Paginated<ModFile>> {
        return invoke('list_mod_files', { modId })
    },
    listModLinks(modId: number): Promise<Paginated<ModLink>> {
        return invoke('list_mod_links', { modId })
    },

    // ── Settings ───────────────────────────────────────────────────────────────
    getSettings(): Promise<Settings> {
        return invoke('get_settings')
    },
    getGameSettings(gameId: string): Promise<GameSettings> {
        return invoke('get_game_settings', { gameId })
    },
    async findGamePath(gameId = 'pd3'): Promise<string | null> {
        await invoke('configure_game_path', { gamePath: null, gameId })
        const gs = await invoke<GameSettings>('get_game_settings', { gameId })
        return gs.gamePath ?? null
    },
    setGamePath(gamePath: string | null, gameId?: string): Promise<void> {
        return invoke('configure_game_path', { gamePath, ...(gameId ? { gameId } : {}) })
    },
    setLauncher(launcher: string, gameId?: string): Promise<void> {
        return invoke('set_launcher', { launcher, ...(gameId ? { gameId } : {}) })
    },
    setLaunchOptions(launchOptions: string, gameId?: string): Promise<void> {
        return invoke('set_launch_options', { launchOptions, ...(gameId ? { gameId } : {}) })
    },
    setCrimeBossInstallMode(mode: string): Promise<void> {
        return invoke('set_crimeboss_install_mode', { mode })
    },
    setSuppressCrashReporter(suppress: boolean, gameId?: string): Promise<void> {
        return invoke('set_suppress_crash_reporter', { suppress, ...(gameId ? { gameId } : {}) })
    },
    setSkipFileOpenLogWarning(skip: boolean): Promise<void> {
        return invoke('set_skip_fileopenlog_warning', { skip })
    },
    dismissDepsWarning(modId: number): Promise<void> {
        return invoke('dismiss_deps_warning', { modId })
    },
    pickFolder(defaultPath?: string): Promise<string | null> {
        return invoke('pick_folder', { defaultPath: defaultPath ?? null })
    },
    openLog(): Promise<void> {
        return invoke('open_log_file')
    },
    openDataFolder(): Promise<void> {
        return invoke('open_data_folder')
    },
    openAppFolder(): Promise<void> {
        return invoke('open_app_folder')
    },

    // ── Storage / data management ─────────────────────────────────────────────
    // Cache sizes/clears are in bytes; clear commands return the bytes freed.
    getStorageUsage(): Promise<{ thumbnails: number; indexDb: number; news: number }> {
        return invoke('get_storage_usage')
    },
    clearThumbnailCache(): Promise<number> {
        return invoke('clear_thumbnail_cache')
    },
    clearIndexCache(): Promise<number> {
        return invoke('clear_index_cache')
    },
    clearNewsCache(): Promise<number> {
        return invoke('clear_news_cache')
    },
    resetAppSettings(): Promise<void> {
        return invoke('reset_app_settings')
    },

    // ── Analytics ────────────────────────────────────────────────────────────────
    // Fire-and-forget: the Rust side gates on consent and swallows errors, so callers
    // never need to await or catch.
    trackEvent(name: string, params?: Record<string, string | number | boolean>): Promise<void> {
        return invoke('track_event', { name, params: params ?? {} })
    },
    // null = the user hasn't been asked yet (show the first-run consent dialog).
    getAnalyticsConsent(): Promise<boolean | null> {
        return invoke('get_analytics_consent')
    },
    setAnalyticsConsent(enabled: boolean): Promise<void> {
        return invoke('set_analytics_consent', { enabled })
    },
    setDiscordPresenceEnabled(enabled: boolean): Promise<void> {
        return invoke('set_discord_presence_enabled', { enabled })
    },
    updateDiscordPresence(game: string): Promise<void> {
        return invoke('update_discord_presence', { game })
    },

    // ── Installed mods ─────────────────────────────────────────────────────────
    getInstalled(
        gameId = 'pd3'
    ): Promise<{ mods: InstalledMod[]; folders: ModFolder[]; modsHidden: boolean }> {
        return invoke('get_installed', { gameId })
    },
    openModsFolder(gameId?: string): Promise<void> {
        return gameId ? invoke('open_mods_folder', { gameId }) : invoke('open_mods_folder')
    },
    listModFolders(gameId: string): Promise<{ tag: string; labelKey: string }[]> {
        return invoke('list_mod_folders', { gameId })
    },
    openModFolder(gameId: string, tag: string): Promise<void> {
        return invoke('open_mod_folder', { gameId, tag })
    },
    installMod(modId: number, gamePath: string, gameId?: string): Promise<void> {
        return trackInstall(invoke('install_mod', { modId, gamePath, gameId }))
    },
    installDroppedFile(
        path: string,
        gamePath: string,
        folderId?: string,
        gameId?: string
    ): Promise<void> {
        return trackInstall(invoke('install_dropped_file', { path, gamePath, folderId, gameId }))
    },
    installModFile(
        modId: number,
        modName: string,
        fileId: number,
        downloadUrl: string,
        fileType: string,
        modVersion: string,
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return trackInstall(
            invoke('install_file', {
                modId,
                modName,
                fileId,
                downloadUrl,
                fileType,
                modVersion,
                gamePath,
                gameId,
            })
        )
    },
    deleteTempFile(path: string): Promise<void> {
        return invoke('delete_temp_file', { path })
    },
    getIndexModFiles(modId: number, gameId?: string): Promise<IndexModFile[]> {
        return invoke('get_index_mod_files', { modId, gameId })
    },

    // ── News ───────────────────────────────────────────────────────────────────
    fetchNews(gameId?: string): Promise<NewsResult> {
        return invoke('fetch_news', { gameId })
    },
    refreshNews(gameId?: string): Promise<NewsResult> {
        return invoke('refresh_news', { gameId })
    },
    fetchNewsPage(gameId: string | undefined, page: number): Promise<NewsResult> {
        return invoke('fetch_news_page', { gameId, page })
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
        folderId?: string | null,
        gameId?: string,
        locationTag?: string,
        entryKind?: string
    ): Promise<void> {
        return trackInstall(
            invoke('install_from_zip_entry', {
                zipPath,
                entryName,
                modId,
                modName,
                fileId,
                fileType,
                modVersion,
                gamePath,
                folderId,
                gameId,
                locationTag,
                entryKind,
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
            invoke('install_cb_flat_archive', {
                zipPath,
                modId,
                modName,
                fileId,
                fileType,
                modVersion,
                gamePath,
                folderId,
            })
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
        gameId?: string
    ): Promise<void> {
        return trackInstall(
            invoke('install_host_pack', {
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
    uninstallMod(uid: string, gamePath: string, gameId?: string): Promise<void> {
        return invoke('uninstall_mod', { uid, gamePath, gameId })
    },
    enableMod(uid: string, gamePath: string, gameId?: string): Promise<void> {
        return invoke('enable_mod', { uid, gamePath, gameId })
    },
    disableMod(uid: string, gamePath: string, gameId?: string): Promise<void> {
        return invoke('disable_mod', { uid, gamePath, gameId })
    },
    moveCrimeBossModTarget(uid: string, gamePath: string): Promise<void> {
        return invoke('move_crimeboss_mod_target', { uid, gamePath })
    },
    reorderModsInFolder(
        folderId: string | null,
        orderedUids: string[],
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return invoke('reorder_in_folder', { folderId, orderedUids, gamePath, gameId })
    },
    moveModToFolder(
        uid: string,
        targetFolderId: string | null,
        targetPosition: number,
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return invoke('move_to_folder', { uid, targetFolderId, targetPosition, gamePath, gameId })
    },
    reorderChildren(
        parentId: string | null,
        items: TopLevelItem[],
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return invoke('reorder_children', { parentId, items, gamePath, gameId })
    },
    moveFolder(
        folderId: string,
        targetParentId: string | null,
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return invoke('move_folder', { folderId, targetParentId, gamePath, gameId })
    },
    createFolder(
        displayName: string,
        parentId: string | null,
        gamePath: string,
        gameId?: string
    ): Promise<ModFolder> {
        return invoke('create_folder', { displayName, parentId, gamePath, gameId })
    },
    renameFolder(
        folderId: string,
        displayName: string,
        gamePath: string,
        gameId?: string
    ): Promise<void> {
        return invoke('rename_folder', { folderId, displayName, gamePath, gameId })
    },
    deleteFolder(folderId: string, gamePath: string, gameId?: string): Promise<void> {
        return invoke('delete_folder', { folderId, gamePath, gameId })
    },

    // ── SuperBLT ───────────────────────────────────────────────────────────────
    checkSuperblt(gamePath: string): Promise<boolean> {
        return invoke('check_superblt', { gamePath })
    },
    installSuperblt(gamePath: string): Promise<void> {
        return invoke('install_superblt', { gamePath })
    },
    isPd2Diesel3(gamePath: string): Promise<boolean> {
        return invoke('is_pd2_diesel3', { gamePath })
    },

    // ── PDTHModOverrides ───────────────────────────────────────────────────────
    checkPdthOverrides(gamePath: string): Promise<boolean> {
        return invoke('check_pdth_overrides', { gamePath })
    },
    installPdthOverrides(gamePath: string): Promise<void> {
        return invoke('install_pdth_overrides', { gamePath })
    },

    // ── DAHM ───────────────────────────────────────────────────────────────────
    checkDahm(gamePath: string): Promise<boolean> {
        return invoke('check_dahm', { gamePath })
    },
    installDahm(gamePath: string): Promise<void> {
        return invoke('install_dahm', { gamePath })
    },

    // ── RAID-SuperBLT ──────────────────────────────────────────────────────────
    checkRaidSuperblt(gamePath: string): Promise<boolean> {
        return invoke('check_raid_superblt', { gamePath })
    },
    installRaidSuperblt(gamePath: string): Promise<void> {
        return invoke('install_raid_superblt', { gamePath })
    },

    // ── UE4SS ────────────────────────────────────────────────────────────────────
    checkUe4ss(gamePath: string, gameId?: string): Promise<boolean> {
        return invoke('check_ue4ss', { gamePath, gameId })
    },

    // ── Launchers & system ─────────────────────────────────────────────────────
    isGameRunning(gameId?: string): Promise<boolean> {
        return gameId ? invoke('is_game_running', { gameId }) : invoke('is_game_running')
    },
    stopGame(gameId?: string): Promise<void> {
        return gameId ? invoke('stop_game', { gameId }) : invoke('stop_game')
    },
    launchModded(gameId?: string): Promise<void> {
        return gameId ? invoke('launch_game', { gameId }) : invoke('launch_game')
    },
    launchWithoutMods(gameId?: string): Promise<void> {
        return gameId ? invoke('launch_without_mods', { gameId }) : invoke('launch_without_mods')
    },
    restoreMods(gameId?: string): Promise<void> {
        return gameId ? invoke('restore_mods', { gameId }) : invoke('restore_mods')
    },
    getInstalledLaunchers(gameId?: string): Promise<string[]> {
        return gameId ? invoke('installed_launchers', { gameId }) : invoke('installed_launchers')
    },
    openExternal(url: string): Promise<void> {
        return invoke('shell_open_external', { url })
    },
    openPath(path: string): Promise<void> {
        return invoke('shell_open_path', { path })
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
        return invoke('get_thumbnail', { filename, full })
    },

    // ── Updater ────────────────────────────────────────────────────────────────
    download(): Promise<void> {
        return invoke('download_update')
    },
    installUpdate(): Promise<void> {
        return invoke('install_update')
    },
    checkForUpdates(): Promise<void> {
        return invoke('check_for_update')
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

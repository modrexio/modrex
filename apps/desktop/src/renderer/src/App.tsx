import {
    useState,
    useEffect,
    useLayoutEffect,
    useCallback,
    memo,
    useRef,
    startTransition,
} from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { Button } from './components/ui/Button'
import { X, ExternalLink, Download } from 'lucide-react'
import type { InstalledMod, ModFolder, GameId, ModSummary } from '../../shared/types'
import { GAMES, isGameId } from '../../shared/types'
import { loadLoaderRegistry } from './loaders'
import { loadSourceRegistry, hasSource } from './sources'
import { t, useLocale } from './i18n'
import { MarkdownContent } from './components/MarkdownContent'
import { Sidebar } from './components/Sidebar'
import { BrowsePage } from './components/BrowsePage'
import { NexusBrowsePage } from './components/NexusBrowsePage'
import { InstalledPage } from './components/InstalledPage'
import { NewsPage } from './components/NewsPage'
import { ModDetailPage } from './components/ModDetailPage'
import { SettingsPage, saveSettingsTab } from './components/SettingsPage'
import { WelcomeScreen } from './components/WelcomeScreen'
import { TopBar } from './components/TopBar'
import { ResizeHandles } from './components/ResizeHandles'
import { SupportPromptBanner } from './components/SupportPromptBanner'
import { NexusSessionBanner } from './components/NexusSessionBanner'
import { api, type StartupPhase } from './api'
import { TelemetryConsentDialog } from './components/TelemetryConsentDialog'
import { FileDropOverlay, FileDropStatus } from './components/FileDropOverlay'
import { useFileDropInstall } from './hooks/useFileDropInstall'
import { ZipPickerModal } from './components/ZipPickerModal'
import { HostPackModal } from './components/HostPackModal'
import { CrimeBossFlatArchiveModal } from './components/CrimeBossFlatArchiveModal'
import { useModIdentificationTracking } from './lib/analytics/useModIdentificationTracking'
import { getSettingsCache, setSettingsCache } from './settingsCache'
import { Dialog } from './components/Dialog'
import { TooltipProvider } from './components/Tooltip'

const InstalledPageMemo = memo(InstalledPage)
const BrowsePageMemo = memo(BrowsePage)

// Warm the settings cache as soon as a game becomes active, so SettingsPage can
// render once with final values instead of showing provisional state that flips.
function warmSettingsCache(game: GameId) {
    if (getSettingsCache(game)) return
    Promise.all([api.getGameSettings(game), api.getDetectedInstalls(game)])
        .then(([settings, installs]) => setSettingsCache(game, { settings, installs }))
        .catch(() => {})
}

export type View = 'browse' | 'installed' | 'news' | 'detail' | 'settings' | 'welcome'

const DETECT_RETRY_MS = 5 * 60 * 1000

function reportStartupPhase(phase: StartupPhase) {
    void api
        .reportStartupPhase(phase)
        .catch((error) => logError('Failed to report startup phase: ' + String(error)))
}

// Falls back to modworkshop whenever the saved source is not one this game offers, which
// also covers a game that has no Nexus presence at all.
function readBrowseSource(gameId: string): string {
    const saved = localStorage.getItem(`modrex:${gameId}:browse-source`)
    return saved && hasSource(gameId, saved) ? saved : 'modworkshop'
}

function getInitialView(): View {
    const game = localStorage.getItem('modrex:active-game')
    if (!game) return 'welcome'
    if (localStorage.getItem('modrex:on-welcome') === '1') return 'welcome'
    const v = localStorage.getItem('modrex:active-view')
    if (v === 'news' && !GAMES[game as GameId]?.hasNews) return 'browse'
    // A saved view of 'nexus' predates the Browse source selector and is not a view any
    // more, so it falls through to Browse, where Nexus lives.
    return v === 'browse' || v === 'installed' || v === 'news' || v === 'settings' ? v : 'browse'
}

export default function App() {
    const locale = useLocale()
    const [view, setView] = useState<View>(getInitialView)
    const [settingsGlobalOnly, setSettingsGlobalOnly] = useState(false)
    // activeGame still holds the last opened game on both game-less screens, so anything
    // game-scoped has to gate on this rather than on view.
    const gameInScope = view !== 'welcome' && !(view === 'settings' && settingsGlobalOnly)
    const showAppBanners = view !== 'welcome'
    const [prevView, setPrevView] = useState<'browse' | 'installed'>('browse')
    const [activeGame, setActiveGame] = useState<GameId>(() => {
        const saved = localStorage.getItem('modrex:active-game')
        return isGameId(saved) ? saved : 'pd3'
    })
    // Which source Browse is showing. Per game because availability is per game (RAID
    // has no Nexus presence) and because a search in one source means nothing in the
    // other, so the pages keep their own state either way.
    const [browseSource, setBrowseSource] = useState<string>(() =>
        readBrowseSource(localStorage.getItem('modrex:active-game') ?? '')
    )
    const [detailStack, setDetailStack] = useState<
        { modId: number; initialMod?: ModSummary; source?: 'nexus' }[]
    >([])
    const [gamePath, setGamePath] = useState<string | null>(null)
    // false while the active game's path is still being resolved this session,
    // consumers must not render "not found" states until this is true.
    const [gamePathReady, setGamePathReady] = useState(false)
    const [installed, setInstalled] = useState<InstalledMod[]>([])
    const [folders, setFolders] = useState<ModFolder[]>([])
    // Per-game membership gates the "no mods" empty state until the first fetch completes.
    const [readyGames, setReadyGames] = useState<ReadonlySet<GameId>>(new Set())
    const startupPending = useRef(true)
    const [modsHidden, setModsHidden] = useState(false)
    const [restoreError, setRestoreError] = useState<string | null>(null)
    const [update, setUpdate] = useState<{
        version: string
        strategy: 'auto' | 'manual' | 'browser'
        phase: 'available' | 'downloading' | 'ready'
        percent: number | null
        body: string
        releaseUrl: string
    } | null>(null)
    const [showUpdateModal, setShowUpdateModal] = useState(false)
    const [showSupportPrompt, setShowSupportPrompt] = useState(false)
    // A discarded Nexus session is app-wide, not per page: it silently stops installed
    // metadata, update checks and background identification everywhere, so it is reported
    // here rather than only on the pages that happen to make a request.
    const [nexusSessionExpired, setNexusSessionExpired] = useState(false)

    // Kept in sync with view so handleSidebarChange can read it without taking view as a dep.
    const viewRef = useRef<View>(view)
    useLayoutEffect(() => {
        viewRef.current = view
    }, [view])

    // Kept in sync with activeGame after every commit so async callbacks can detect staleness.
    const activeGameRef = useRef<GameId>(activeGame)
    // Cheap client-side debounce against overlapping get_installed calls. Correctness no
    // longer depends on it: the backend's per-game StateLocks serializes every state
    // read-modify-write, this just avoids queueing redundant refreshes.
    const isRefreshingInstalled = useRef(false)
    useLayoutEffect(() => {
        activeGameRef.current = activeGame
        // A game switch invalidates any in-flight refresh for the previous game so the
        // first refresh for the new game isn't blocked by the previous game's lock.
        isRefreshingInstalled.current = false
    }, [activeGame])

    useModIdentificationTracking(installed, activeGame)

    // Analytics consent, owned here as the single source of truth so the first-run
    // pop-up and the Settings toggle stay in sync. undefined = not loaded yet,
    // null = loaded but undecided (prompt), boolean = the user's choice.
    const [analyticsConsent, setAnalyticsConsent] = useState<boolean | null | undefined>(undefined)
    useEffect(() => {
        api.getAnalyticsConsent().then(setAnalyticsConsent)
    }, [])
    const handleAnalyticsConsent = useCallback((enabled: boolean) => {
        setAnalyticsConsent(enabled)
        void api.setAnalyticsConsent(enabled)
    }, [])

    const [discordPresenceEnabled, setDiscordPresenceEnabled] = useState(true)
    const handleDiscordPresenceEnabled = useCallback((enabled: boolean) => {
        setDiscordPresenceEnabled(enabled)
        void api.setDiscordPresenceEnabled(enabled)
    }, [])
    useEffect(() => {
        void api.updateDiscordPresence(gameInScope ? GAMES[activeGame].name : '')
    }, [activeGame, gameInScope])

    // undefined = not yet loaded; null = path not found this session.
    const gamePathCache = useRef<Partial<Record<GameId, string | null>>>({})

    // Re-detecting a missing game runs a full launcher scan, so it repeats only after the
    // TTL, not on every switch or focus.
    const failedDetectAt = useRef<Partial<Record<GameId, number>>>({})

    // undefined = not yet loaded.
    const installedCache = useRef<
        Partial<Record<GameId, { mods: InstalledMod[]; folders: ModFolder[]; modsHidden: boolean }>>
    >({})

    const refreshGamePath = useCallback(async () => {
        const game = activeGame
        if (gamePathCache.current[game] === null) {
            const failedAt = failedDetectAt.current[game]
            if (failedAt !== undefined && Date.now() - failedAt < DETECT_RETRY_MS) {
                setGamePath(null)
                setGamePathReady(true)
                return
            }
        }
        const path = await api.findGamePath(game)
        if (activeGameRef.current !== game) return
        if (path === null) failedDetectAt.current[game] = Date.now()
        else delete failedDetectAt.current[game]
        gamePathCache.current[game] = path
        setGamePath(path)
        setGamePathReady(true)
    }, [activeGame])

    function handleShowWelcome() {
        localStorage.setItem('modrex:on-welcome', '1')
        setDetailStack([])
        setView('welcome')
    }

    function handleGameChange(g: GameId) {
        localStorage.setItem('modrex:active-game', g)
        localStorage.removeItem('modrex:on-welcome')
        const cachedPath = gamePathCache.current[g]
        const cachedInstalled = installedCache.current[g]
        const saved = localStorage.getItem('modrex:active-view')
        const dest: View =
            (saved === 'browse' ||
                saved === 'installed' ||
                saved === 'news' ||
                saved === 'settings') &&
            (saved !== 'news' || GAMES[g].hasNews)
                ? saved
                : 'browse'
        localStorage.setItem('modrex:active-view', dest)
        setBrowseSource(readBrowseSource(g))
        // The switch commit renders three pages' worth of tree at once, so as a
        // transition it stays interruptible, so rapid switching can't pile up
        // janky frames (a newer switch cancels the in-progress render).
        startTransition(() => {
            setActiveGame(g)
            setSettingsGlobalOnly(false)
            // Restore the last-known path for this game so the UI never flashes
            // "not found" while refreshGamePath re-validates in the background.
            setGamePath(cachedPath !== undefined ? cachedPath : null)
            setGamePathReady(cachedPath !== undefined)
            // Restore last-known installed state so the installed page never
            // flashes empty while refreshInstalled re-validates in the background.
            if (cachedInstalled) {
                setInstalled(cachedInstalled.mods)
                setFolders(cachedInstalled.folders)
                setModsHidden(cachedInstalled.modsHidden)
            } else {
                setInstalled([])
                setFolders([])
                setModsHidden(false)
            }
            setView(dest)
        })
    }

    const refreshInstalled = useCallback(async () => {
        if (isRefreshingInstalled.current) return
        isRefreshingInstalled.current = true
        try {
            const game = activeGame
            const result = await api.getInstalled(game)
            if (activeGameRef.current !== game) return
            // Unchanged result (the common case for focus refreshes), so skip the state
            // fan-out entirely: the fresh array refs would otherwise re-render the full
            // installed list and the browse grid for nothing. A cache hit implies this
            // game is already in readyGames.
            const prev = installedCache.current[game]
            if (prev && JSON.stringify(prev) === JSON.stringify(result)) return
            installedCache.current[game] = result
            setInstalled(result.mods)
            setFolders(result.folders)
            setModsHidden(result.modsHidden)
            setReadyGames((prev) => (prev.has(game) ? prev : new Set(prev).add(game)))
        } finally {
            isRefreshingInstalled.current = false
        }
    }, [activeGame])

    async function handleRestoreMods() {
        setRestoreError(null)
        try {
            await api.restoreMods(activeGame)
            await refreshInstalled()
        } catch (e) {
            setRestoreError(String(e))
        }
    }

    // Path resolution must finish (persisting any newly detected path to settings)
    // before get_installed reads it, since fetching concurrently can return a false-empty
    // list that gets cached as truth.
    const refreshAll = useCallback(async () => {
        const starting = startupPending.current
        if (starting) reportStartupPhase('game')
        try {
            await refreshGamePath()
        } catch {
            // detection failure must not block the installed fetch
        }
        if (starting) reportStartupPhase('mods')
        try {
            await refreshInstalled()
        } catch (error) {
            if (!starting) throw error
            logError('Initial installed-mod refresh failed: ' + String(error))
            reportStartupPhase('error')
        }
    }, [refreshGamePath, refreshInstalled])

    // Manual path pick must bypass the failed-detection throttle, because the user just
    // gave us a valid path, so the "not found" verdict is stale by definition.
    const handleGamePathSet = useCallback(async () => {
        delete failedDetectAt.current[activeGameRef.current]
        await refreshAll()
    }, [refreshAll])

    useEffect(() => {
        reportStartupPhase('interface')
    }, [])

    // The loader registry backs synchronous lookups in render paths (dep warnings,
    // loader badges), so it is loaded once here before those pages can be reached.
    useEffect(() => {
        void loadLoaderRegistry()
        void loadSourceRegistry()
    }, [])

    useEffect(() => {
        refreshAll()
        let timer: ReturnType<typeof setTimeout> | null = null
        function onFocus() {
            if (timer) clearTimeout(timer)
            timer = setTimeout(refreshAll, 500)
        }
        window.addEventListener('focus', onFocus)
        return () => {
            window.removeEventListener('focus', onFocus)
            if (timer) clearTimeout(timer)
        }
    }, [refreshAll])

    useEffect(() => {
        if (!startupPending.current || readyGames.size === 0) return
        startupPending.current = false
        reportStartupPhase('ready')
    }, [readyGames])

    useEffect(() => {
        warmSettingsCache(activeGame)
    }, [activeGame])

    useEffect(() => {
        // Dev builds run whatever version the branch has and would nag about the
        // latest release on every launch, the check only makes sense for real installs.
        if (import.meta.env.DEV) return
        api.checkForUpdates().catch(() => {})
    }, [])

    // A Nexus install arrives via the OS nxm:// deep link, not an in-app action,
    // so nothing else triggers the installed-list refresh for it.
    useEffect(() => {
        return api.onNxmInstallComplete(({ gameId }) => {
            if (gameId === activeGameRef.current) void refreshInstalled()
        })
    }, [refreshInstalled])

    useEffect(() => {
        const offAvailable = api.onUpdateAvailable(({ version, strategy, body, releaseUrl }) => {
            setUpdate({
                version,
                strategy,
                phase: 'available',
                percent: null,
                body,
                releaseUrl,
            })
            setShowUpdateModal(true)
        })
        const offProgress = api.onUpdateProgress((percent) =>
            setUpdate((prev) => (prev ? { ...prev, percent } : prev))
        )
        const offReady = api.onUpdateReady(() =>
            setUpdate((prev) => (prev ? { ...prev, phase: 'ready' } : prev))
        )
        return () => {
            offAvailable()
            offProgress()
            offReady()
        }
    }, [])

    useEffect(() => api.onSupportPromptEligible(() => setShowSupportPrompt(true)), [])

    useEffect(() => {
        const offExpired = api.onNexusSessionExpired(() => setNexusSessionExpired(true))
        // Signing in from anywhere resolves it, including the Settings section, so this
        // listens for the outcome rather than being wired to the banner's own button.
        const offSignedIn = api.onNexusOAuthSignedIn(() => setNexusSessionExpired(false))
        return () => {
            offExpired()
            offSignedIn()
        }
    }, [])

    async function handleUpdate() {
        if (!update) return
        setShowUpdateModal(false)
        setUpdate((prev) => (prev ? { ...prev, phase: 'downloading', percent: 0 } : prev))
        try {
            await api.download()
        } catch {
            setUpdate((prev) => (prev ? { ...prev, phase: 'available', percent: null } : prev))
            setShowUpdateModal(true)
        }
    }

    const openDetail = useCallback(
        (
            modId: number,
            from: 'browse' | 'installed',
            initialMod?: ModSummary,
            source?: 'nexus'
        ) => {
            setPrevView(from)
            setDetailStack([{ modId, initialMod, source }])
            setView('detail')
        },
        []
    )

    const openDetailFromInstalled = useCallback(
        (id: number, source?: 'nexus') => openDetail(id, 'installed', undefined, source),
        [openDetail]
    )

    const pushDetail = useCallback((modId: number) => {
        setDetailStack((prev) => {
            const existingIndex = prev.findIndex((d) => d.modId === modId)
            if (existingIndex !== -1) return prev.slice(0, existingIndex + 1)
            return [...prev, { modId }]
        })
    }, [])

    function closeDetail() {
        if (detailStack.length > 1) {
            setDetailStack((prev) => prev.slice(0, -1))
            return
        }
        setView(prevView)
        setDetailStack([])
    }

    const handleSidebarChange = useCallback(
        (v: 'browse' | 'installed' | 'news' | 'settings') => {
            const isGlobalOnly = v === 'settings' && viewRef.current === 'welcome'
            if (v === 'settings') setSettingsGlobalOnly(isGlobalOnly)
            // Do not persist global-only settings to localStorage, since it is a transient
            // overlay on the picker, not the user's intended destination after game select.
            if (!isGlobalOnly) {
                localStorage.setItem('modrex:active-view', v)
                localStorage.removeItem('modrex:on-welcome')
            }
            setDetailStack([])
            setView(v)
        },
        [setSettingsGlobalOnly]
    )

    const openDetailFromBrowse = useCallback(
        (modId: number, initialMod?: ModSummary) => openDetail(modId, 'browse', initialMod),
        [openDetail]
    )

    const openDetailFromNexus = useCallback(
        (modId: number, initialMod?: ModSummary) =>
            openDetail(modId, 'browse', initialMod, 'nexus'),
        [openDetail]
    )

    const goToSettings = useCallback(() => handleSidebarChange('settings'), [handleSidebarChange])

    const handleSourceChange = useCallback(
        (next: string) => {
            setBrowseSource(next)
            localStorage.setItem(`modrex:${activeGame}:browse-source`, next)
        },
        [activeGame]
    )

    const goToNexusSettings = useCallback(() => {
        saveSettingsTab('advanced')
        handleSidebarChange('settings')
    }, [handleSidebarChange])

    const sidebarView =
        view === 'detail' || view === 'welcome'
            ? prevView
            : (view as 'browse' | 'installed' | 'news' | 'settings')

    const {
        dragging: fileDragging,
        installing: fileInstalling,
        progress: dropProgress,
        result: dropResult,
        dismissResult,
        sentinel: dropSentinel,
        resolveSentinel,
    } = useFileDropInstall({
        gamePath,
        activeGame,
        enabled: gameInScope,
        onRefreshInstalled: refreshInstalled,
    })

    return (
        <TooltipProvider delayDuration={400}>
            <div key={locale} className="flex flex-col h-screen bg-surface text-text">
                <FileDropOverlay
                    active={fileDragging || fileInstalling}
                    installing={fileInstalling}
                    progress={dropProgress}
                    gameName={GAMES[activeGame].name}
                />
                {dropResult && <FileDropStatus result={dropResult} onDismiss={dismissResult} />}
                {dropSentinel?.kind === 'zip' && gamePath && (
                    <ZipPickerModal
                        payload={dropSentinel.payload}
                        gamePath={gamePath}
                        installedFiles={installed}
                        gameId={activeGame}
                        onRefreshInstalled={refreshInstalled}
                        onClose={resolveSentinel}
                    />
                )}
                {dropSentinel?.kind === 'host' && gamePath && (
                    <HostPackModal
                        payload={dropSentinel.payload}
                        gamePath={gamePath}
                        installed={installed}
                        gameId={activeGame}
                        onRefreshInstalled={refreshInstalled}
                        onClose={resolveSentinel}
                    />
                )}
                {dropSentinel?.kind === 'cb' && gamePath && (
                    <CrimeBossFlatArchiveModal
                        payload={dropSentinel.payload}
                        gamePath={gamePath}
                        onRefreshInstalled={refreshInstalled}
                        onClose={resolveSentinel}
                    />
                )}
                {navigator.userAgent.includes('Linux') && <ResizeHandles />}
                <>
                    <TopBar
                        gamePath={gamePath}
                        activeGame={activeGame}
                        onRefreshInstalled={refreshInstalled}
                        update={
                            update && update.phase !== 'available'
                                ? { phase: update.phase, percent: update.percent }
                                : null
                        }
                        onDismissUpdate={() => setUpdate(null)}
                        hideGameActions={!gameInScope}
                    />
                    {gameInScope && modsHidden && (
                        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
                            <span>{t('app.modsHidden')}</span>
                            <div className="flex items-center gap-3 shrink-0">
                                {restoreError && (
                                    <span className="text-danger-text">{restoreError}</span>
                                )}
                                <button
                                    onClick={handleRestoreMods}
                                    className="px-3 py-1 rounded bg-warning/20 hover:bg-warning/30 transition-colors"
                                >
                                    {t('app.restoreMods')}
                                </button>
                            </div>
                        </div>
                    )}
                    {nexusSessionExpired && showAppBanners && (
                        <NexusSessionBanner onDismiss={() => setNexusSessionExpired(false)} />
                    )}
                    {showSupportPrompt && showAppBanners && (
                        <SupportPromptBanner onClose={() => setShowSupportPrompt(false)} />
                    )}
                    <div className="flex flex-1 overflow-hidden">
                        <Sidebar
                            view={sidebarView}
                            onViewChange={handleSidebarChange}
                            activeGame={activeGame}
                            onShowWelcome={handleShowWelcome}
                            mode={gameInScope ? 'app' : 'picker'}
                        />
                        {/* Pages are stacked absolute panes toggled with visibility, not
                                display:none — un-hiding a display:none subtree re-layouts it
                                from scratch and re-decodes every image, which made tab switches
                                stutter. A visibility flip is paint-only. */}
                        <main className="relative flex-1 overflow-hidden">
                            <div
                                className={`absolute inset-0 ${view === 'welcome' ? '' : 'invisible pointer-events-none'}`}
                            >
                                {/* Mounted only while active, unlike the other panes: its effect
                                    scans every game's launcher path on mount, which shouldn't run
                                    on every app launch just because this pane exists in the DOM. */}
                                {view === 'welcome' && (
                                    <WelcomeScreen onSelectGame={handleGameChange} />
                                )}
                            </div>
                            <div
                                className={`absolute inset-0 ${view === 'browse' && browseSource === 'modworkshop' ? '' : 'invisible pointer-events-none'}`}
                            >
                                <BrowsePageMemo
                                    key={activeGame}
                                    activeGame={activeGame}
                                    isActive={view === 'browse' && browseSource === 'modworkshop'}
                                    source={browseSource}
                                    onSourceChange={handleSourceChange}
                                    gamePath={gamePath}
                                    gamePathReady={gamePathReady}
                                    installed={installed}
                                    onRefreshInstalled={refreshInstalled}
                                    onOpenDetail={openDetailFromBrowse}
                                    onGoToSettings={goToSettings}
                                />
                            </div>
                            <div
                                className={`absolute inset-0 ${view === 'browse' && browseSource === 'nexus' ? '' : 'invisible pointer-events-none'}`}
                            >
                                {hasSource(activeGame, 'nexus') && (
                                    <NexusBrowsePage
                                        key={activeGame}
                                        activeGame={activeGame}
                                        isActive={view === 'browse' && browseSource === 'nexus'}
                                        source={browseSource}
                                        onSourceChange={handleSourceChange}
                                        gamePath={gamePath}
                                        installed={installed}
                                        onRefreshInstalled={refreshInstalled}
                                        onGoToSettings={goToNexusSettings}
                                        onOpenDetail={openDetailFromNexus}
                                    />
                                )}
                            </div>
                            <div
                                className={`absolute inset-0 ${view === 'installed' ? '' : 'invisible pointer-events-none'}`}
                            >
                                <InstalledPageMemo
                                    activeGame={activeGame}
                                    gamePath={gamePath}
                                    installed={installed}
                                    folders={folders}
                                    installedReady={readyGames.has(activeGame)}
                                    isActive={view === 'installed'}
                                    onRefreshInstalled={refreshInstalled}
                                    onOpenDetail={openDetailFromInstalled}
                                />
                            </div>
                            <div
                                className={`absolute inset-0 ${view === 'news' ? '' : 'invisible pointer-events-none'}`}
                            >
                                <NewsPage isActive={view === 'news'} activeGame={activeGame} />
                            </div>
                            <div
                                className={`absolute inset-0 ${view === 'settings' ? '' : 'invisible pointer-events-none'}`}
                            >
                                <SettingsPage
                                    key={activeGame}
                                    activeGame={activeGame}
                                    isActive={view === 'settings'}
                                    gamePath={gamePath}
                                    gamePathReady={gamePathReady}
                                    onGamePathChange={handleGamePathSet}
                                    analyticsConsent={analyticsConsent ?? null}
                                    onAnalyticsConsent={handleAnalyticsConsent}
                                    discordPresenceEnabled={discordPresenceEnabled}
                                    onDiscordPresenceEnabled={handleDiscordPresenceEnabled}
                                    globalOnly={settingsGlobalOnly}
                                />
                            </div>
                            {detailStack.map(({ modId, initialMod, source }, i) => (
                                <div
                                    key={`${source ?? 'modworkshop'}:${modId}`}
                                    className={`absolute inset-0 ${view === 'detail' && i === detailStack.length - 1 ? '' : 'invisible pointer-events-none'}`}
                                >
                                    <ModDetailPage
                                        modId={modId}
                                        initialMod={initialMod}
                                        source={source}
                                        isActive={view === 'detail' && i === detailStack.length - 1}
                                        gamePath={gamePath}
                                        installed={installed}
                                        activeGame={activeGame}
                                        onBack={closeDetail}
                                        onRefreshInstalled={refreshInstalled}
                                        onOpenDetail={pushDetail}
                                    />
                                </div>
                            ))}
                        </main>
                    </div>
                </>

                <Dialog
                    open={showUpdateModal && !!update && update.phase === 'available'}
                    onOpenChange={(open) => !open && setShowUpdateModal(false)}
                    title={update ? t('app.updateNotesTitle', { version: update.version }) : ''}
                    className="w-full max-w-lg max-h-[80vh]"
                >
                    {update && (
                        <>
                            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
                                <h2 className="text-sm font-semibold">
                                    {t('app.updateNotesTitle', { version: update.version })}
                                </h2>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setShowUpdateModal(false)}
                                    className="-m-1"
                                >
                                    <X className="w-4 h-4" />
                                </Button>
                            </div>
                            {update.body && (
                                <div className="overflow-y-auto px-5 py-4 flex-1">
                                    <MarkdownContent text={update.body} />
                                </div>
                            )}
                            <div className="px-5 py-4 border-t border-border shrink-0 flex items-center justify-between">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => api.openExternal(update.releaseUrl)}
                                    className="-mx-2 px-2"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    {t('app.updateViewOnGithub')}
                                </Button>
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setShowUpdateModal(false)}
                                    >
                                        {t('app.updateLater')}
                                    </Button>
                                    {update.strategy !== 'browser' ? (
                                        <button
                                            onClick={handleUpdate}
                                            className="text-xs px-3 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors flex items-center gap-1.5"
                                        >
                                            <Download className="w-3.5 h-3.5" />
                                            {t('app.updateAction')}
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => api.openExternal(update.releaseUrl)}
                                            className="text-xs px-3 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors flex items-center gap-1.5"
                                        >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            {t('app.updateDownload')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </Dialog>

                {/* Window-global dialogs must not be gated by `view`. The welcome/game
                    picker is a content pane in this same window, not a separate window, and
                    this dialog portals above it like the update dialog. It is a forced
                    first-run choice, and first run is always `view === 'welcome'`, so gating
                    on view hid it on first launch until a game was picked. */}
                <TelemetryConsentDialog
                    open={analyticsConsent === null}
                    onChoice={handleAnalyticsConsent}
                />
            </div>
        </TooltipProvider>
    )
}

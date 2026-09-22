import { useState, useEffect, useLayoutEffect, useCallback, useRef, startTransition } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { Button } from './components/ui/Button'
import { X, ExternalLink, Download, RefreshCw } from 'lucide-react'
import { GAMES, isGameId, type GameId } from '../../shared/types'
import { loadLoaderRegistry } from './loaders'
import { loadSourceRegistry } from './sources'
import { t, useLocale } from './i18n'
import { MarkdownContent } from './components/MarkdownContent'
import { Sidebar } from './components/Sidebar'
import { SettingsPage } from './components/SettingsPage'
import { WelcomeScreen } from './components/WelcomeScreen'
import { TopBar } from './components/TopBar'
import { ResizeHandles } from './components/ResizeHandles'
import { SupportPromptBanner } from './components/SupportPromptBanner'
import { NexusSessionBanner } from './components/NexusSessionBanner'
import { api, type StartupPhase } from './api'
import { TelemetryConsentDialog } from './components/TelemetryConsentDialog'
import { Dialog } from './components/Dialog'
import { TooltipProvider } from './components/Tooltip'
import { FileDropInstall } from './components/FileDropInstall'
import { GameWorkspace } from './GameWorkspace'
import { readAppRoute, saveAppRoute, type AppRoute } from './navigation'
import { refreshInstalled } from './gameData'
function reportStartupPhase(phase: StartupPhase) {
    void api
        .reportStartupPhase(phase)
        .catch((error) => logError('Failed to report startup phase: ' + String(error)))
}

export default function App() {
    const locale = useLocale()
    const [route, setRoute] = useState<AppRoute>(readAppRoute)
    const startupPending = useRef(true)
    const onStartupPhase = useCallback((phase: StartupPhase) => {
        if (!startupPending.current) return
        reportStartupPhase(phase)
        if (phase === 'ready') startupPending.current = false
    }, [])

    useLayoutEffect(() => {
        reportStartupPhase('interface')
    }, [])
    useEffect(() => {
        saveAppRoute(route)
        if (route.kind !== 'game') onStartupPhase('ready')
    }, [route, onStartupPhase])

    const presenceGame = route.kind === 'game' ? GAMES[route.gameId].name : ''
    useEffect(() => {
        void api.updateDiscordPresence(presenceGame)
    }, [presenceGame])

    function handleShowWelcome() {
        setRoute({ kind: 'picker' })
    }
    function handleGlobalSettings() {
        setRoute({ kind: 'global-settings' })
    }
    function handleGameChange(gameId: GameId) {
        startTransition(() => setRoute({ kind: 'game', gameId }))
    }

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
    // The loader registry backs synchronous lookups in render paths (dep warnings,
    // loader badges), so it is loaded once here before those pages can be reached.
    useEffect(() => {
        void loadLoaderRegistry()
        void loadSourceRegistry()
    }, [])

    useEffect(() => {
        // Dev builds run whatever version the branch has and would nag about the
        // latest release on every launch, the check only makes sense for real installs.
        if (import.meta.env.DEV) return
        api.checkForUpdates().catch(() => {})
    }, [])

    useEffect(
        () =>
            api.onNxmInstallComplete(({ gameId }) => {
                if (!isGameId(gameId)) {
                    void logError('Nexus install completed for an unknown game: ' + gameId)
                    return
                }
                void refreshInstalled(gameId).catch((error) =>
                    logError('Installed refresh failed: ' + String(error))
                )
            }),
        []
    )

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
        setUpdate((prev) => (prev ? { ...prev, phase: 'downloading', percent: 0 } : prev))
        try {
            await api.download()
        } catch {
            setUpdate((prev) => (prev ? { ...prev, phase: 'available', percent: null } : prev))
            setShowUpdateModal(true)
        }
    }

    const settings = {
        analyticsConsent: analyticsConsent ?? null,
        onAnalyticsConsent: handleAnalyticsConsent,
        discordPresenceEnabled,
        onDiscordPresenceEnabled: handleDiscordPresenceEnabled,
    }
    const topBar = {
        update:
            update && update.phase !== 'available' && !showUpdateModal
                ? { phase: update.phase, percent: update.percent }
                : null,
        onDismissUpdate: () => setUpdate(null),
    }
    const banners = (
        <>
            {nexusSessionExpired && (
                <NexusSessionBanner onDismiss={() => setNexusSessionExpired(false)} />
            )}
            {showSupportPrompt && (
                <SupportPromptBanner onClose={() => setShowSupportPrompt(false)} />
            )}
        </>
    )

    return (
        <TooltipProvider delayDuration={400}>
            <FileDropInstall>
                <div className="flex flex-col h-screen bg-surface text-text">
                    {navigator.userAgent.includes('Linux') && <ResizeHandles />}
                    {route.kind === 'game' ? (
                        <GameWorkspace
                            key={route.gameId}
                            activeGame={route.gameId}
                            onShowWelcome={handleShowWelcome}
                            settings={settings}
                            topBar={topBar}
                            banners={banners}
                            onStartupPhase={onStartupPhase}
                        />
                    ) : (
                        <div key={locale} className="contents">
                            <TopBar {...topBar} />
                            {route.kind === 'global-settings' && banners}
                            <div className="flex flex-1 overflow-hidden">
                                <Sidebar
                                    navigation={{
                                        kind: 'global',
                                        view: route.kind === 'picker' ? 'picker' : 'settings',
                                        onViewChange: handleGlobalSettings,
                                    }}
                                    onShowWelcome={handleShowWelcome}
                                />
                                <main className="relative flex-1 overflow-hidden">
                                    {route.kind === 'picker' ? (
                                        <WelcomeScreen onSelectGame={handleGameChange} />
                                    ) : (
                                        <SettingsPage {...settings} isActive />
                                    )}
                                </main>
                            </div>
                        </div>
                    )}
                    <Dialog
                        open={showUpdateModal && !!update}
                        onOpenChange={(open) => !open && setShowUpdateModal(false)}
                        onPointerDownOutside={(event) => {
                            const target = event.detail.originalEvent.target
                            if (
                                target instanceof Element &&
                                target.closest('[data-tauri-drag-region], [data-window-resize]')
                            ) {
                                event.preventDefault()
                            }
                        }}
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
                                    <div className="overflow-y-auto px-5 py-4 flex-1 [&>div>:first-child]:mt-0">
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
                                        {update.phase === 'available' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setShowUpdateModal(false)}
                                            >
                                                {t('app.updateLater')}
                                            </Button>
                                        )}
                                        {update.phase === 'ready' && (
                                            <Button
                                                variant="accent"
                                                onClick={() => api.installUpdate()}
                                            >
                                                <RefreshCw className="w-3.5 h-3.5" />
                                                {t('app.updateInstall')}
                                            </Button>
                                        )}
                                        {update.phase === 'available' &&
                                            update.strategy !== 'browser' && (
                                                <Button variant="accent" onClick={handleUpdate}>
                                                    <Download className="w-3.5 h-3.5" />
                                                    {t('app.updateAction')}
                                                </Button>
                                            )}
                                        {update.phase === 'available' &&
                                            update.strategy === 'browser' && (
                                                <Button
                                                    variant="accent"
                                                    onClick={() =>
                                                        api.openExternal(update.releaseUrl)
                                                    }
                                                >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                    {t('app.updateDownload')}
                                                </Button>
                                            )}
                                    </div>
                                </div>
                                {update.phase === 'downloading' && (
                                    <div className="absolute bottom-0 left-0 right-0 h-4">
                                        <span className="absolute right-2 bottom-1 text-[10px] text-text-muted">
                                            {update.percent ?? 0}%
                                        </span>
                                        <div
                                            role="progressbar"
                                            aria-label={t('common.downloading')}
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={update.percent ?? 0}
                                            className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-active"
                                        >
                                            <div
                                                className="h-full bg-accent transition-[width] duration-100"
                                                style={{ width: `${update.percent ?? 0}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </Dialog>

                    <TelemetryConsentDialog
                        open={analyticsConsent === null}
                        onChoice={handleAnalyticsConsent}
                    />
                </div>
            </FileDropInstall>
        </TooltipProvider>
    )
}

import { useState, useEffect, useCallback, useSyncExternalStore, memo, type ReactNode } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import type { GameId, ModSummary, InstalledMod, ModFolder } from '../../shared/types'
import { GAMES } from '../../shared/types'
import { api, type StartupPhase } from './api'
import { hasSource } from './sources'
import { t, useLocale } from './i18n'
import {
    getGameData,
    subscribeGameData,
    refreshGamePath,
    refreshInstalled as refreshGameInstalled,
    clearFailedDetection,
} from './gameData'
import { getSettingsCache, setSettingsCache } from './settingsCache'
import { readGameView, saveGameView, type GameView } from './navigation'
import { useModIdentificationTracking } from './lib/analytics/useModIdentificationTracking'
import { Button } from './components/ui/Button'
import { Sidebar } from './components/Sidebar'
import { GameTopBar } from './components/GameTopBar'
import type { TopBarProps } from './components/TopBar'
import { BrowsePage } from './components/BrowsePage'
import { NexusBrowsePage } from './components/NexusBrowsePage'
import { InstalledPage } from './components/InstalledPage'
import { NewsPage } from './components/NewsPage'
import { ModDetailPage } from './components/ModDetailPage'
import { SettingsPage, saveSettingsTab, type AppSettingsProps } from './components/SettingsPage'
import { GameSettings } from './components/GameSettings'
import { GameFolders } from './components/GameFolders'
import { useFileDropTarget } from './components/FileDropInstall'

const InstalledPageMemo = memo(InstalledPage)
const BrowsePageMemo = memo(BrowsePage)
const emptyMods: InstalledMod[] = []
const emptyFolders: ModFolder[] = []

// Falls back to modworkshop whenever the saved source is not one this game offers, which
// also covers a game that has no Nexus presence at all.
function readBrowseSource(gameId: string): string {
    const saved = localStorage.getItem(`modrex:${gameId}:browse-source`)
    return saved && hasSource(gameId, saved) ? saved : 'modworkshop'
}

interface Props {
    activeGame: GameId
    onShowWelcome: () => void
    settings: Omit<AppSettingsProps, 'isActive'>
    topBar: TopBarProps
    banners: ReactNode
    onStartupPhase: (phase: StartupPhase) => void
}

export function GameWorkspace({
    activeGame,
    onShowWelcome,
    settings,
    topBar,
    banners,
    onStartupPhase,
}: Props) {
    const locale = useLocale()
    const [view, setView] = useState<GameView | 'detail'>(() => readGameView(activeGame))
    const [prevView, setPrevView] = useState<'browse' | 'installed'>('browse')
    const [browseSource, setBrowseSource] = useState(() => readBrowseSource(activeGame))
    const [detailStack, setDetailStack] = useState<
        { modId: number; initialMod?: ModSummary; source?: 'nexus' }[]
    >([])
    const [restoreError, setRestoreError] = useState<string | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const subscribe = useCallback(
        (listener: () => void) => subscribeGameData(activeGame, listener),
        [activeGame]
    )
    const snapshot = useCallback(() => getGameData(activeGame), [activeGame])
    const data = useSyncExternalStore(subscribe, snapshot)
    const gamePath = data.path ?? null
    const gamePathReady = data.path !== undefined
    const installed = data.installed?.mods ?? emptyMods
    const folders = data.installed?.folders ?? emptyFolders
    const refreshInstalled = useCallback(() => refreshGameInstalled(activeGame), [activeGame])

    useModIdentificationTracking(installed, activeGame)
    useFileDropTarget({ activeGame, gamePath, installed })

    useEffect(() => {
        let cancelled = false
        async function refresh() {
            try {
                onStartupPhase('game')
                await refreshGamePath(activeGame)
                if (cancelled) return
                onStartupPhase('mods')
                await refreshInstalled()
                if (cancelled) return
                setLoadError(null)
                onStartupPhase('ready')
            } catch (error) {
                if (cancelled) return
                setLoadError(String(error))
                void logError('Game refresh failed: ' + String(error))
                onStartupPhase('error')
            }
        }
        void refresh()
        let timer: ReturnType<typeof setTimeout> | undefined
        function onFocus() {
            clearTimeout(timer)
            timer = setTimeout(refresh, 500)
        }
        window.addEventListener('focus', onFocus)
        return () => {
            cancelled = true
            clearTimeout(timer)
            window.removeEventListener('focus', onFocus)
        }
    }, [activeGame, refreshInstalled, onStartupPhase])

    useEffect(() => {
        if (getSettingsCache(activeGame)) return
        Promise.all([api.getGameSettings(activeGame), api.getDetectedInstalls(activeGame)])
            .then(([gameSettings, installs]) =>
                setSettingsCache(activeGame, { settings: gameSettings, installs })
            )
            .catch((error) => logError('Settings prefetch failed: ' + String(error)))
    }, [activeGame])

    const handleGamePathSet = useCallback(async () => {
        clearFailedDetection(activeGame)
        await refreshGamePath(activeGame)
        await refreshInstalled()
    }, [activeGame, refreshInstalled])

    async function handleRestoreMods() {
        setRestoreError(null)
        try {
            await api.restoreMods(activeGame)
            await refreshInstalled()
        } catch (error) {
            setRestoreError(String(error))
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
            const existingIndex = prev.findIndex((d) => d.modId === modId && !d.source)
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
        (next: GameView) => {
            saveGameView(activeGame, next)
            setDetailStack([])
            setView(next)
        },
        [activeGame]
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

    const sidebarView = view === 'detail' ? prevView : view
    return (
        <div key={locale} className="contents">
            <GameTopBar {...topBar} activeGame={activeGame} gamePath={gamePath} />
            {loadError && (
                <div role="alert" className="shrink-0 px-4 py-2 bg-danger text-xs text-danger-text">
                    {loadError}
                </div>
            )}
            {data.installed?.stateUnreadable && (
                <div className="shrink-0 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
                    {t('app.stateUnreadable')}
                </div>
            )}
            {data.installed?.modsHidden && (
                <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
                    <span>{t('app.modsHidden')}</span>
                    <div className="flex items-center gap-3 shrink-0">
                        {restoreError && <span className="text-danger-text">{restoreError}</span>}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRestoreMods}
                            className="bg-warning/20 hover:bg-warning/30 text-warning"
                        >
                            {t('app.restoreMods')}
                        </Button>
                    </div>
                </div>
            )}
            {banners}
            <div className="flex flex-1 overflow-hidden">
                <Sidebar
                    navigation={{
                        kind: 'game',
                        activeGame,
                        view: sidebarView,
                        onViewChange: handleSidebarChange,
                    }}
                    onShowWelcome={onShowWelcome}
                />
                {/* Visibility preserves pane layout and decoded images across tab switches. */}
                <main className="relative flex-1 overflow-hidden">
                    <div
                        className={`absolute inset-0 ${view === 'browse' && browseSource === 'modworkshop' ? '' : 'invisible pointer-events-none'}`}
                    >
                        {GAMES[activeGame].workshopId !== undefined && (
                            <BrowsePageMemo
                                key={activeGame}
                                activeGame={activeGame}
                                workshopId={GAMES[activeGame].workshopId}
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
                        )}
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
                            installedReady={data.installed !== undefined}
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
                            {...settings}
                            isActive={view === 'settings'}
                            game={{
                                name: GAMES[activeGame].name,
                                content: (
                                    <GameSettings
                                        activeGame={activeGame}
                                        gamePath={gamePath}
                                        gamePathReady={gamePathReady}
                                        onGamePathChange={handleGamePathSet}
                                    />
                                ),
                                folders: (
                                    <GameFolders activeGame={activeGame} gamePath={gamePath} />
                                ),
                            }}
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
        </div>
    )
}

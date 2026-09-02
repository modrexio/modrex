import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { Button } from './ui/Button'
import { Play, Square, TriangleAlert, X, RefreshCw, Loader } from 'lucide-react'
import { Dialog, DialogHeader } from './Dialog'
import { WindowControls } from './WindowControls'
import { Tooltip } from './Tooltip'
import { t } from '../i18n'
import { api } from '../api'
import type { SisrLaunchIssue } from '../api'
import type { GameId } from '../../../shared/types'
import { GAMES } from '../../../shared/types'

interface UpdateState {
    phase: 'downloading' | 'ready'
    percent: number | null
}

interface Props {
    gamePath: string | null
    activeGame: GameId
    onRefreshInstalled: () => Promise<void>
    update?: UpdateState | null
    onDismissUpdate?: () => void
    hideGameActions?: boolean
}

export function TopBar({
    gamePath,
    activeGame,
    onRefreshInstalled,
    update,
    onDismissUpdate,
    hideGameActions,
}: Props) {
    const [gameRunning, setGameRunning] = useState(false)
    const [launching, setLaunching] = useState<'modded' | 'vanilla' | null>(null)
    const [showWarning, setShowWarning] = useState(false)
    const [dontShowAgain, setDontShowAgain] = useState(false)
    const [launchError, setLaunchError] = useState<string | null>(null)
    const [launchWarning, setLaunchWarning] = useState<SisrLaunchIssue | null>(null)
    const wasRunning = useRef(false)
    const pendingRestore = useRef(false)
    const missedWhileLaunching = useRef(0)
    const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Kept in sync with activeGame so in-flight poll results from a switched-away
    // game can be discarded. All running/launching state belongs to the previous
    // game after a switch, so reset before paint and it never bleeds through.
    const activeGameRef = useRef(activeGame)
    useLayoutEffect(() => {
        activeGameRef.current = activeGame
        setGameRunning(false)
        setLaunching(null)
        wasRunning.current = false
        pendingRestore.current = false
        missedWhileLaunching.current = 0
        if (launchTimeoutRef.current) {
            clearTimeout(launchTimeoutRef.current)
            launchTimeoutRef.current = null
        }
    }, [activeGame])

    function startLaunching(mode: 'modded' | 'vanilla') {
        setLaunchError(null)
        setLaunchWarning(null)
        setLaunching(mode)
        missedWhileLaunching.current = 0
        if (launchTimeoutRef.current) clearTimeout(launchTimeoutRef.current)
        launchTimeoutRef.current = setTimeout(() => setLaunching(null), 60_000)
    }

    useEffect(() => {
        if (hideGameActions) return
        const check = async () => {
            const game = activeGame
            const running = await api.isGameRunning(game)
            if (activeGameRef.current !== game) return
            if (!running && wasRunning.current) {
                if (pendingRestore.current) {
                    try {
                        await api.restoreMods(activeGame)
                    } catch (e) {
                        setLaunchError(String(e))
                    }
                }
                pendingRestore.current = false
                await onRefreshInstalled()
            }
            if (running) {
                setLaunching(null)
                if (launchTimeoutRef.current) {
                    clearTimeout(launchTimeoutRef.current)
                    launchTimeoutRef.current = null
                }
            } else if (launchTimeoutRef.current !== null) {
                // 3 attempts at 3 s, so 9 s max before concluding the game crashed at startup
                if (++missedWhileLaunching.current >= 3) {
                    setLaunching(null)
                    clearTimeout(launchTimeoutRef.current)
                    launchTimeoutRef.current = null
                    missedWhileLaunching.current = 0
                }
            }
            wasRunning.current = running
            setGameRunning(running)
        }
        check()
        const id = setInterval(check, 3000)
        return () => clearInterval(id)
    }, [onRefreshInstalled, activeGame, hideGameActions])

    async function handleLaunchModded() {
        const requiredFlag = GAMES[activeGame].requiredLaunchFlag
        if (requiredFlag) {
            const settings = await api.getSettings()
            if (
                !settings.skipFileOpenLogWarning &&
                !settings.launchOptions?.includes(requiredFlag)
            ) {
                setDontShowAgain(false)
                setShowWarning(true)
                return
            }
        }
        await launchModded()
    }

    async function confirmLaunch() {
        if (dontShowAgain) await api.setSkipFileOpenLogWarning(true)
        setShowWarning(false)
        await launchModded()
    }

    async function launchModded() {
        const game = activeGame
        startLaunching('modded')
        try {
            const warning = await api.launchModded(game)
            if (activeGameRef.current !== game) return
            setLaunchWarning(warning)
        } catch (error) {
            if (activeGameRef.current !== game) return
            setLaunching(null)
            if (launchTimeoutRef.current) {
                clearTimeout(launchTimeoutRef.current)
                launchTimeoutRef.current = null
            }
            setLaunchError(String(error))
        }
    }

    async function launchWithoutMods() {
        if (!gamePath) return
        const game = activeGame
        try {
            startLaunching('vanilla')
            const warning = await api.launchWithoutMods(game)
            if (activeGameRef.current !== game) return
            setLaunchWarning(warning)
            pendingRestore.current = true
        } catch (e) {
            if (activeGameRef.current !== game) return
            setLaunching(null)
            if (launchTimeoutRef.current) {
                clearTimeout(launchTimeoutRef.current)
                launchTimeoutRef.current = null
            }
            setLaunchError(String(e))
        }
    }

    function stopGame() {
        api.stopGame(activeGame)
    }

    return (
        <>
            {/* z-[60] keeps the title bar above the startup splash (z-50) and Radix
                dialog overlays (z-50); pointer-events-auto re-enables it under Radix's
                modal body pointer-events lock, so the window stays draggable and
                closable during startup and while any modal is open. */}
            <div className="shrink-0 bg-surface border-b border-border relative z-[60] pointer-events-auto">
                <div data-tauri-drag-region className="h-10 flex items-center justify-between pl-4">
                    <div className="flex items-end gap-2 pointer-events-none">
                        <span
                            style={{
                                fontFamily: "'Bebas Neue', sans-serif",
                                fontSize: '1.375rem',
                                letterSpacing: '0.05em',
                                lineHeight: 1,
                            }}
                        >
                            <span style={{ color: 'var(--color-text)' }}>MOD</span>
                            <span style={{ color: 'var(--color-accent)' }}>REX</span>
                        </span>
                        <span
                            className="text-xs text-text-subtle"
                            style={{ marginBottom: '0.3rem' }}
                        >
                            {import.meta.env.DEV ? 'v-dev' : `v${import.meta.env.VITE_APP_VERSION}`}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 h-full">
                        {update?.phase === 'ready' && (
                            <>
                                <button
                                    onClick={() => api.installUpdate()}
                                    className="text-xs px-3 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors flex items-center gap-1.5"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    {t('app.updateInstall')}
                                </button>
                                <Tooltip content={t('common.dismiss')}>
                                    <Button variant="ghost" size="icon" onClick={onDismissUpdate}>
                                        <X className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                                <div className="w-px h-4 bg-border mx-1" />
                            </>
                        )}
                        {!hideGameActions &&
                            (gameRunning ? (
                                <Button variant="danger" size="sm" onClick={stopGame}>
                                    <Square className="w-3.5 h-3.5" fill="currentColor" />
                                    {t('topBar.stopGame')}
                                </Button>
                            ) : (
                                <>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={!gamePath || !!launching}
                                        onClick={launchWithoutMods}
                                    >
                                        {launching === 'vanilla' ? (
                                            <Loader className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <Play className="w-3.5 h-3.5" fill="currentColor" />
                                        )}
                                        {launching === 'vanilla'
                                            ? t('topBar.launching')
                                            : t('topBar.launchWithoutMods')}
                                    </Button>
                                    <Button
                                        variant="accent"
                                        size="sm"
                                        disabled={!gamePath || !!launching}
                                        onClick={handleLaunchModded}
                                    >
                                        {launching === 'modded' ? (
                                            <Loader className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <Play className="w-3.5 h-3.5" fill="currentColor" />
                                        )}
                                        {launching === 'modded'
                                            ? t('topBar.launching')
                                            : t('topBar.launchModded')}
                                    </Button>
                                </>
                            ))}
                        <div className="w-px h-4 bg-border ml-1" />
                        <WindowControls />
                    </div>
                </div>
                {update?.phase === 'downloading' && (
                    <div className="h-0.5 bg-surface-hover">
                        <div
                            className="h-full bg-accent transition-all duration-300"
                            style={{ width: `${update.percent ?? 0}%` }}
                        />
                    </div>
                )}
            </div>
            {launchError && (
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-danger border-b border-danger-hover text-xs text-danger-text">
                    <span>{launchError}</span>
                    <button
                        onClick={() => setLaunchError(null)}
                        className="shrink-0 hover:text-text transition-colors"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}
            {launchWarning && (
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
                    <span>{t(`topBar.sisr.${launchWarning}`)}</span>
                    <button
                        onClick={() => setLaunchWarning(null)}
                        className="shrink-0 hover:text-text transition-colors"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            <Dialog
                open={showWarning}
                onOpenChange={(open) => !open && setShowWarning(false)}
                title={t('topBar.missingLaunchOption.title')}
                className="w-96"
            >
                <DialogHeader
                    title={t('topBar.missingLaunchOption.title')}
                    icon={<TriangleAlert className="w-4 h-4 text-warning shrink-0" />}
                    onClose={() => setShowWarning(false)}
                    wrapSubtitle
                    subtitle={
                        <>
                            <span className="font-mono text-text">
                                {GAMES[activeGame].requiredLaunchFlag}
                            </span>{' '}
                            {t('topBar.missingLaunchOption.bodyPre')}{' '}
                            <span className="text-text">
                                {t('topBar.missingLaunchOption.location')}
                            </span>
                            .
                        </>
                    }
                />
                <div className="flex items-center justify-between px-6 py-4 shrink-0">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={dontShowAgain}
                            onChange={(e) => setDontShowAgain(e.target.checked)}
                        />
                        <span className="text-xs text-text-muted">{t('common.dontShowAgain')}</span>
                    </label>
                    <div className="flex gap-2">
                        <Button variant="secondary" size="md" onClick={() => setShowWarning(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button variant="accent" size="md" onClick={confirmLaunch}>
                            {t('topBar.missingLaunchOption.launchAnyway')}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </>
    )
}

import { useCallback, useState, useSyncExternalStore } from 'react'
import { Play, Square, X, Loader } from 'lucide-react'
import { TopBar, type TopBarProps } from './TopBar'
import { Button } from './ui/Button'
import { Tooltip } from './Tooltip'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { GAMES, type GameId } from '../../../shared/types'
import {
    getLaunchState,
    subscribeLaunchState,
    launchGame,
    stopGame,
    dismissLaunchError,
    dismissLaunchWarning,
    resetPendingLaunch,
} from '../gameLaunch'

export function GameTopBar({
    activeGame,
    gamePath,
    ...topBar
}: TopBarProps & { activeGame: GameId; gamePath: string | null }) {
    const game = GAMES[activeGame]
    const [resetOpen, setResetOpen] = useState(false)
    const [resetting, setResetting] = useState(false)
    const [resetError, setResetError] = useState<string | null>(null)
    const hasResources = !!game.movieReplacement || !!game.configPresets
    const launchDescription = game.movieReplacement
        ? game.configPresets
            ? t('resources.launchDescription')
            : t('resources.launchMoviesDescription')
        : game.configPresets
          ? t('resources.launchConfigDescription')
          : t('topBar.launchWithoutMods')
    const subscribe = useCallback(
        (listener: () => void) => subscribeLaunchState(activeGame, listener),
        [activeGame]
    )
    const snapshot = useCallback(() => getLaunchState(activeGame), [activeGame])
    const {
        running: gameRunning,
        launching,
        pending,
        error: launchError,
        warning: launchWarning,
    } = useSyncExternalStore(subscribe, snapshot)

    async function reset() {
        setResetting(true)
        setResetError(null)
        try {
            await resetPendingLaunch(activeGame)
            setResetOpen(false)
        } catch (error) {
            setResetError(String(error))
        } finally {
            setResetting(false)
        }
    }
    return (
        <>
            <TopBar {...topBar}>
                {gameRunning ? (
                    <Button variant="danger" size="sm" onClick={() => stopGame(activeGame)}>
                        <Square className="w-3.5 h-3.5" fill="currentColor" />
                        {t('topBar.stopGame')}
                    </Button>
                ) : (
                    <>
                        <Tooltip content={launchDescription}>
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={!gamePath || !!launching || !!pending}
                                onClick={() => launchGame(activeGame, 'vanilla')}
                            >
                                {launching === 'vanilla' ? (
                                    <Loader className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Play className="w-3.5 h-3.5" fill="currentColor" />
                                )}
                                {launching === 'vanilla'
                                    ? t('topBar.launching')
                                    : hasResources
                                      ? t('resources.launchWithoutPackages')
                                      : t('topBar.launchWithoutMods')}
                            </Button>
                        </Tooltip>
                        <Button
                            variant="accent"
                            size="sm"
                            disabled={!gamePath || !!launching || !!pending}
                            onClick={() => launchGame(activeGame, 'modded')}
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
                        {pending === 'handedOff' && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                    setResetError(null)
                                    setResetOpen(true)
                                }}
                            >
                                {t('topBar.resetLaunchStatus')}
                            </Button>
                        )}
                    </>
                )}
            </TopBar>
            <Dialog
                open={resetOpen}
                onOpenChange={(open) => !resetting && setResetOpen(open)}
                title={t('topBar.resetLaunchStatus')}
                className="w-[28rem] max-w-[95vw]"
            >
                <DialogHeader
                    title={t('topBar.resetLaunchStatus')}
                    subtitle={game.name}
                    closeDisabled={resetting}
                    onClose={() => setResetOpen(false)}
                />
                <div className="p-5 flex flex-col gap-3 text-sm">
                    <p>{t('topBar.resetLaunchDescription')}</p>
                    {resetError && (
                        <p role="alert" className="text-xs text-danger-text whitespace-pre-wrap">
                            {resetError}
                        </p>
                    )}
                </div>
                <div className="flex justify-end gap-2 p-4 border-t border-border">
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={resetting}
                        onClick={() => setResetOpen(false)}
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="accent"
                        size="sm"
                        disabled={resetting}
                        onClick={() => void reset()}
                    >
                        {resetting && (
                            <Loader aria-hidden="true" className="w-3.5 h-3.5 animate-spin" />
                        )}
                        {t('topBar.resetLaunchStatus')}
                    </Button>
                </div>
            </Dialog>
            {launchError && (
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-danger border-b border-danger-hover text-xs text-danger-text">
                    <span>{launchError}</span>
                    <Tooltip content={t('common.close')}>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => dismissLaunchError(activeGame)}
                            className="shrink-0 p-0 text-danger-text hover:bg-transparent"
                        >
                            <X className="w-3.5 h-3.5" />
                        </Button>
                    </Tooltip>
                </div>
            )}
            {launchWarning && (
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
                    <span>{t(`topBar.sisr.${launchWarning}`)}</span>
                    <Tooltip content={t('common.close')}>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => dismissLaunchWarning(activeGame)}
                            className="shrink-0 p-0 text-warning hover:bg-transparent"
                        >
                            <X className="w-3.5 h-3.5" />
                        </Button>
                    </Tooltip>
                </div>
            )}
        </>
    )
}

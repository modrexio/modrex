import { useCallback, useSyncExternalStore } from 'react'
import { Play, Square, X, Loader } from 'lucide-react'
import { TopBar, type TopBarProps } from './TopBar'
import { Button } from './ui/Button'
import { Tooltip } from './Tooltip'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import {
    getLaunchState,
    subscribeLaunchState,
    launchGame,
    stopGame,
    dismissLaunchError,
    dismissLaunchWarning,
} from '../gameLaunch'

export function GameTopBar({
    activeGame,
    gamePath,
    ...topBar
}: TopBarProps & { activeGame: GameId; gamePath: string | null }) {
    const subscribe = useCallback(
        (listener: () => void) => subscribeLaunchState(activeGame, listener),
        [activeGame]
    )
    const snapshot = useCallback(() => getLaunchState(activeGame), [activeGame])
    const {
        running: gameRunning,
        launching,
        error: launchError,
        warning: launchWarning,
    } = useSyncExternalStore(subscribe, snapshot)
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
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={!gamePath || !!launching}
                            onClick={() => launchGame(activeGame, 'vanilla')}
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
                    </>
                )}
            </TopBar>
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

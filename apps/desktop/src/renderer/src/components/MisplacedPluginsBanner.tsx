import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Square, Wrench, X } from 'lucide-react'
import { t } from '../i18n'
import { Button } from './ui/Button'
import { ProgressLine } from './ui/ProgressLine'
import { requestInstallChoice } from '../installChoices'
import {
    getModInstall,
    installLabel,
    installProgress,
    modworkshopDownloadId,
    useInstallOperations,
} from '../installState'
import { loaderForModId } from '../loaders'
import { api, type MisplacedPlugin, type PluginInstallReport } from '../api'
import type { GameId, InstalledMod } from '../../../shared/types'

interface Props {
    activeGame: GameId
    gamePath: string
    installed: InstalledMod[]
    onRefreshInstalled: () => Promise<void>
}

/**
 * Offers to reinstall plugin mods found as loose paks, and points at a descriptor left in the
 * plugin folder itself. The game loads neither.
 */
export function MisplacedPluginsBanner({
    activeGame,
    gamePath,
    installed,
    onRefreshInstalled,
}: Props) {
    const [report, setReport] = useState<PluginInstallReport | null>(null)
    const [repairing, setRepairing] = useState<{
        plugin: MisplacedPlugin
        done: number
        total: number
    } | null>(null)
    const [failures, setFailures] = useState<string[]>([])
    const [checkError, setCheckError] = useState<string | null>(null)
    const [stopping, setStopping] = useState(false)
    const stopRequested = useRef(false)
    const operations = useInstallOperations(activeGame)

    // A change to the installed list is what changes the answer.
    useEffect(() => {
        let cancelled = false
        api.checkPluginInstalls(activeGame).then(
            (found) => {
                if (cancelled) return
                setReport(found)
                setCheckError(null)
            },
            (e: unknown) => {
                if (!cancelled) setCheckError(String(e))
            }
        )
        return () => {
            cancelled = true
        }
    }, [activeGame, installed])

    const misplaced = report?.misplaced ?? []
    const rootDescriptor = report?.rootDescriptor ?? null
    const target = report?.target ?? null
    const problems = checkError === null ? failures : [checkError, ...failures]
    if (misplaced.length === 0 && rootDescriptor === null && problems.length === 0) return null

    async function repairAll() {
        // Loader first, so the mods after it load even if a later repair fails.
        const ordered = [...misplaced].sort(
            (a, b) =>
                Number(loaderForModId(activeGame, b.modId) !== undefined) -
                Number(loaderForModId(activeGame, a.modId) !== undefined)
        )
        const failed: string[] = []
        stopRequested.current = false
        for (const [index, plugin] of ordered.entries()) {
            if (stopRequested.current) break
            setRepairing({ plugin, done: index, total: ordered.length })
            try {
                // A plugin install removes the mod's loose paks, so it is the whole repair.
                const outcome = await api.installMod(
                    plugin.modId,
                    gamePath,
                    activeGame,
                    plugin.fileId
                )
                await requestInstallChoice(
                    outcome,
                    activeGame,
                    gamePath,
                    installed,
                    null,
                    plugin.modId
                )
            } catch (e) {
                failed.push(
                    t('installed.misplacedPlugins.failed', { name: plugin.name, error: String(e) })
                )
            }
        }
        try {
            await onRefreshInstalled()
        } catch (e) {
            failed.push(String(e))
        }
        setRepairing(null)
        setStopping(false)
        setFailures(failed)
    }

    const count = misplaced.length
    const operation = repairing
        ? getModInstall(operations, 'modworkshop', repairing.plugin.modId, repairing.plugin.fileId)
        : undefined
    const progress = installProgress(operation)
    return (
        <div className="relative px-6 py-2 shrink-0 flex flex-col gap-1 bg-warning/10 border-b border-warning/30 text-warning text-xs">
            {count > 0 && (
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        {repairing && (
                            <span className="shrink-0 tabular-nums">
                                {repairing.done}/{repairing.total}
                            </span>
                        )}
                        <span className="truncate">
                            {repairing
                                ? t('installed.misplacedPlugins.repairing', {
                                      name: repairing.plugin.name,
                                  })
                                : count === 1
                                  ? t('installed.misplacedPlugins.messageSingle', { count })
                                  : t('installed.misplacedPlugins.message', { count })}
                        </span>
                        {operation && (
                            <span className="shrink-0 tabular-nums">{installLabel(operation)}</span>
                        )}
                    </div>
                    {repairing ? (
                        <Button
                            variant="warning"
                            className="shrink-0"
                            disabled={stopping}
                            onClick={() => {
                                stopRequested.current = true
                                setStopping(true)
                                // Past its download a mod finishes, since its install either
                                // completes or rolls back.
                                void api.cancelDownload(
                                    modworkshopDownloadId(
                                        repairing.plugin.modId,
                                        repairing.plugin.fileId
                                    )
                                )
                            }}
                        >
                            <Square className="w-3.5 h-3.5" fill="currentColor" />
                            {t('installed.misplacedPlugins.stop')}
                        </Button>
                    ) : (
                        <Button
                            variant="warning"
                            className="shrink-0"
                            onClick={() => void repairAll()}
                        >
                            <Wrench className="w-3.5 h-3.5" />
                            {t('common.fix')}
                        </Button>
                    )}
                </div>
            )}
            {progress && (
                <ProgressLine progress={progress} className="absolute bottom-0 left-0 right-0" />
            )}
            {rootDescriptor !== null && target !== null && (
                <div className="flex items-center justify-between gap-3">
                    <span>
                        {t('installed.misplacedPlugins.rootDescriptor', { file: rootDescriptor })}
                    </span>
                    <Button
                        variant="warning"
                        className="shrink-0"
                        onClick={() => void api.openModFolder(activeGame, target)}
                    >
                        <FolderOpen className="w-3.5 h-3.5" />
                        {t('installed.openFolder')}
                    </Button>
                </div>
            )}
            {problems.length > 0 && (
                <div className="flex items-start justify-between gap-3 text-danger">
                    <div className="flex flex-col gap-1">
                        {problems.map((problem) => (
                            <span key={problem}>{problem}</span>
                        ))}
                    </div>
                    <button
                        onClick={() => {
                            setFailures([])
                            setCheckError(null)
                        }}
                        aria-label={t('common.dismiss')}
                        className="shrink-0 hover:opacity-70 transition-opacity"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}
        </div>
    )
}

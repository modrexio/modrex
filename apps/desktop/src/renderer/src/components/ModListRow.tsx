import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui/Button'
import { Trash2, RotateCcw, Image as ImageIcon } from 'lucide-react'
import { Toggle } from './Toggle'
import type { InstalledMod, ModSummary } from '../../../shared/types'
import { t } from '../i18n'
import { Tooltip } from './Tooltip'
import { useThumbnail } from '../hooks/useThumbnail'
import { hasCatalogLink } from '../hooks/installedUtils'
import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'

interface Props {
    mod: ModSummary
    installed: InstalledMod
    gamePath: string | null
    loading: boolean
    progress?: { downloaded: number; total: number } | null
    isDragging?: boolean
    onOpen: () => void
    onUninstall: () => void
    onEnable: () => void
    onDisable: () => void
    onReinstall?: () => void
    optionsButton?: ReactNode
}

export function ModListRow({
    mod,
    installed,
    gamePath,
    loading,
    progress = null,
    isDragging,
    onOpen,
    onUninstall,
    onEnable,
    onDisable,
    onReinstall,
    optionsButton,
}: Props) {
    const thumbSrc = useThumbnail(mod.thumbnail?.file)
    // Fade the image in on its first real decode; cache hits (el.complete is
    // already true at mount) skip the fade so warm lists stay instant.
    const [thumbLoaded, setThumbLoaded] = useState(false)
    const canAct = !!gamePath && !loading

    const progressPct =
        loading && progress && progress.total > 0
            ? Math.round((progress.downloaded / progress.total) * 100)
            : null

    return (
        <div className="group relative rounded-lg border bg-surface-raised border-border hover:border-accent/25 transition-colors overflow-hidden">
            <div
                className={`flex items-stretch transition-opacity ${isDragging || loading ? 'opacity-40' : 'opacity-100'}`}
            >
                <div
                    onClick={onOpen}
                    className="relative shrink-0 w-28 bg-surface-hover cursor-pointer"
                >
                    {thumbSrc ? (
                        <img
                            src={thumbSrc}
                            alt=""
                            loading="lazy"
                            ref={(el) => {
                                if (el?.complete) setThumbLoaded(true)
                            }}
                            onLoad={() => setThumbLoaded(true)}
                            className={`w-full h-full object-cover transition-[filter,opacity] ${thumbLoaded ? '' : 'opacity-0'} ${!installed.enabled ? 'grayscale group-hover:grayscale-0' : 'group-hover:brightness-110'}`}
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            {installed.source === 'nexus' ? (
                                <NexusIcon className="w-6 h-6 text-text-subtle" />
                            ) : (
                                <ImageIcon
                                    className="w-6 h-6 text-text-subtle"
                                    aria-hidden="true"
                                />
                            )}
                            <span className="sr-only">{t('common.noImage')}</span>
                        </div>
                    )}
                    {installed.source === 'nexus' && (
                        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-surface-raised/80 border border-border text-[10px] text-text-subtle pointer-events-none flex items-center gap-1">
                            <NexusIcon className="w-3 h-3" />
                            {t('installed.nexusBadge')}
                        </div>
                    )}
                </div>

                <button onClick={onOpen} className="flex-1 min-w-0 text-left px-5 py-4">
                    <p className="text-sm font-bold leading-snug truncate group-hover:text-accent-bright transition-colors">
                        {mod.name}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5 truncate">By {mod.user.name}</p>
                    <p className="text-xs text-text-subtle mt-1 tabular-nums">
                        {installed.version}
                    </p>
                </button>

                <div className="flex items-center gap-2 px-4 shrink-0">
                    {installed.missing && (
                        <>
                            <span className="text-xs text-warning bg-warning/10 border border-warning/30 px-2 py-0.5 rounded">
                                {t('common.fileMissing')}
                            </span>
                            {hasCatalogLink(installed) &&
                                (!installed.source || installed.source === 'modworkshop') && (
                                    <Tooltip content={t('common.reinstall')}>
                                        <button
                                            disabled={!canAct}
                                            onClick={onReinstall}
                                            className="p-2 rounded bg-warning/20 hover:bg-warning/30 border border-warning/30 text-warning disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <RotateCcw className="w-4 h-4" />
                                        </button>
                                    </Tooltip>
                                )}
                        </>
                    )}
                    {installed.archiveBroken && (
                        <>
                            <span className="text-xs text-warning bg-warning/10 border border-warning/30 px-2 py-0.5 rounded">
                                {t('common.zipArchiveBroken')}
                            </span>
                            <button
                                disabled={!canAct}
                                onClick={onReinstall}
                                className="text-xs px-2 py-0.5 rounded bg-warning/20 hover:bg-warning/30 border border-warning/30 text-warning disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {t('common.fix')}
                            </button>
                        </>
                    )}
                    <Toggle
                        checked={installed.enabled}
                        onChange={(v) => (v ? onEnable() : onDisable())}
                        disabled={!canAct || !!installed.missing}
                    />
                    <Tooltip content={t('common.remove')}>
                        <Button
                            variant="danger"
                            size="icon-md"
                            disabled={!canAct}
                            onClick={onUninstall}
                            className="p-2"
                        >
                            <Trash2 className="w-4 h-4" />
                        </Button>
                    </Tooltip>
                    {optionsButton}
                </div>
            </div>
            {loading && progress !== null && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-active">
                    {progressPct !== null ? (
                        <div
                            className="h-full bg-accent transition-[width] duration-100"
                            style={{ width: `${progressPct}%` }}
                        />
                    ) : (
                        <div className="h-full bg-accent animate-pulse w-full" />
                    )}
                </div>
            )}
        </div>
    )
}

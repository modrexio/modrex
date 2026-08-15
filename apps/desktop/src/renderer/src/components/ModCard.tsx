import { useState } from 'react'
import { Download, Heart, Eye, Clock, Trash2, RotateCcw, Image as ImageIcon } from 'lucide-react'
import { Toggle } from './Toggle'
import type { InstalledMod, ModSummary } from '../../../shared/types'
import { t } from '../i18n'
import { Tooltip } from './Tooltip'
import { useThumbnail } from '../hooks/useThumbnail'
import { Button } from './ui/Button'
import { formatCount, formatRelativeTime } from './modDetail/format'
import { hasCatalogLink } from '../hooks/installedUtils'
import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'

interface Props {
    mod: ModSummary
    installed: InstalledMod | undefined
    installedCount?: number
    loaderInstalled?: boolean
    onOpen: () => void
    onInstall: () => void
    onUninstall: () => void
    onEnable: () => void
    onDisable: () => void
    onReinstall?: () => void
    onPrefetch?: () => void
    loading: boolean
    gamePath: string | null
    progress?: { downloaded: number; total: number } | null
    showMeta?: boolean
}

export function ModCard({
    mod,
    installed,
    installedCount,
    loaderInstalled,
    onOpen,
    onInstall,
    onUninstall,
    onEnable,
    onDisable,
    onReinstall,
    onPrefetch,
    loading,
    gamePath,
    progress = null,
    showMeta = false,
}: Props) {
    // Full-size: the small CDN variant is only 256 px wide and upscales badly
    // at card width.
    const thumbSrc = useThumbnail(mod.thumbnail?.file, true)
    // Fade the image in on its first real decode; cache hits (el.complete is
    // already true at mount) skip the fade so warm grids stay instant.
    const [thumbLoaded, setThumbLoaded] = useState(false)
    const canAct = !!gamePath && !loading

    const progressPct =
        loading && progress && progress.total > 0
            ? Math.round((progress.downloaded / progress.total) * 100)
            : null

    return (
        <div
            className="h-full bg-surface-raised border border-border rounded-lg overflow-hidden flex flex-col transition-colors hover:border-accent/25"
            onMouseEnter={onPrefetch}
        >
            <div className="cursor-pointer group relative" onClick={onOpen}>
                {thumbSrc ? (
                    <img
                        src={thumbSrc}
                        alt={mod.name}
                        loading="lazy"
                        ref={(el) => {
                            if (el?.complete) setThumbLoaded(true)
                        }}
                        onLoad={() => setThumbLoaded(true)}
                        className={`w-full h-36 object-cover transition-opacity ${thumbLoaded ? '' : 'opacity-0'}${installed && !installed.enabled ? ' grayscale' : ''}`}
                    />
                ) : (
                    <div className="w-full h-36 bg-surface-hover flex items-center justify-center">
                        {installed?.source === 'nexus' ? (
                            <NexusIcon className="w-8 h-8 text-text-subtle" />
                        ) : (
                            <ImageIcon className="w-8 h-8 text-text-subtle" aria-hidden="true" />
                        )}
                        <span className="sr-only">{t('common.noImage')}</span>
                    </div>
                )}
                {installedCount !== undefined && installedCount > 1 && (
                    <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-surface-raised/80 border border-border text-[10px] text-text-subtle pointer-events-none">
                        {t('installed.fileCount', { count: installedCount })}
                    </div>
                )}
                {installed?.source === 'nexus' && (
                    <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-surface-raised/80 border border-border text-[10px] text-text-subtle pointer-events-none flex items-center gap-1">
                        <NexusIcon className="w-3 h-3" />
                        {t('installed.nexusBadge')}
                    </div>
                )}
                <div className="px-3 pt-3 pb-1 flex flex-col gap-1 min-h-[76px]">
                    <h3 className="text-sm font-semibold leading-[20px] line-clamp-2 group-hover:text-accent-bright transition-colors">
                        {mod.name}
                    </h3>
                    <p className="text-xs leading-4 text-text-muted">{mod.user.name}</p>
                </div>
            </div>

            <div className="px-3 pb-3 pt-2 flex items-center justify-between mt-auto">
                <div className="flex items-center">
                    {installed && !showMeta ? (
                        <span className="text-xs text-text-subtle">{installed.version}</span>
                    ) : (
                        <div className="flex items-center gap-3 text-xs text-text-subtle">
                            {mod.likes > 0 && (
                                <span className="flex items-center gap-1">
                                    <Heart className="w-3 h-3" />
                                    {formatCount(mod.likes)}
                                </span>
                            )}
                            {mod.downloads > 0 && (
                                <span className="flex items-center gap-1">
                                    <Download className="w-3 h-3" />
                                    {formatCount(mod.downloads)}
                                </span>
                            )}
                            {mod.views > 0 && (
                                <span className="flex items-center gap-1">
                                    <Eye className="w-3 h-3" />
                                    {formatCount(mod.views)}
                                </span>
                            )}
                            {mod.bumped_at && (
                                <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {formatRelativeTime(mod.bumped_at)}
                                </span>
                            )}
                        </div>
                    )}
                </div>
                {loaderInstalled && (
                    <span className="text-xs text-success-text">
                        {t('detail.deps.statusInstalled')}
                    </span>
                )}
                {!installed && !loaderInstalled && (
                    <Button
                        variant="accent"
                        size="sm"
                        disabled={!canAct || !mod.has_download || !!mod.disable_mod_managers}
                        title={
                            mod.disable_mod_managers ? t('common.modManagerDisabled') : undefined
                        }
                        onClick={onInstall}
                    >
                        {!loading && <Download className="w-3.5 h-3.5" />}
                        {loading
                            ? progressPct !== null
                                ? `${progressPct}%`
                                : progress
                                  ? t('common.downloading')
                                  : t('common.installing')
                            : t('common.install')}
                    </Button>
                )}
                {installed && (
                    <div className="flex items-center gap-2">
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
                                                className="p-1.5 rounded bg-warning/20 hover:bg-warning/30 border border-warning/30 text-warning disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
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
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
            </div>

            {loading && progress !== null && (
                <div className="h-0.5 bg-surface-active">
                    {progress.total > 0 ? (
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

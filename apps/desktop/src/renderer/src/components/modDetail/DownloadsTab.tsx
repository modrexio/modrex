import { useState } from 'react'
import {
    AlertTriangle,
    Tag,
    Download,
    Clock,
    ExternalLink,
    Trash2,
    Image as ImageIcon,
} from 'lucide-react'
import { Button } from '../ui/Button'
import type {
    ModFile,
    ModLink,
    InstalledMod,
    GameId,
    ModSummary,
    ModImage,
} from '../../../../shared/types'
import { THUMBNAIL_BASE_URL, GAMES } from '../../../../shared/types'
import { api } from '../../api'
import { requestInstallChoice } from '../../installChoices'
import {
    useInstallOperations,
    getModInstall,
    isInstallBusy,
    installLabel,
} from '../../installState'
import { t } from '../../i18n'
import { isUnsupportedFormat } from '../../formatCheck'
import { useCrimeBossInstallTarget } from '../../hooks/useCrimeBossInstallTarget'
import { ModworkshopMarkup } from '../MarkdownContent'
import { NexusDescription } from '../NexusDescription'
import { Tooltip } from '../Tooltip'
import { CrimeBossInstallTargetModal } from '../CrimeBossInstallTargetModal'
import { NonPakConfirmModal } from '../NonPakConfirmModal'
import { formatBytes, formatDate } from './format'
import { SkeletonBar } from '../Skeleton'

// Nexus's own category order for a file listing (its site groups files the same way).
// A file with no category (rare, but real) falls into 'MAIN' rather than getting its own
// bucket, since an uncategorized file is Nexus's default meaning for one anyway.
const NEXUS_CATEGORY_ORDER = ['MAIN', 'UPDATE', 'OPTIONAL', 'OLD_VERSION', 'MISCELLANEOUS']

function nexusCategoryLabel(key: string): string {
    switch (key) {
        case 'MAIN':
            return t('detail.downloads.categoryMain')
        case 'UPDATE':
            return t('detail.downloads.categoryUpdate')
        case 'OPTIONAL':
            return t('detail.downloads.categoryOptional')
        case 'OLD_VERSION':
            return t('detail.downloads.categoryOldVersion')
        case 'MISCELLANEOUS':
            return t('detail.downloads.categoryMiscellaneous')
        default:
            return key
    }
}

function groupNexusFiles(files: ModFile[]): { key: string; label: string; files: ModFile[] }[] {
    const byKey = new Map<string, ModFile[]>()
    for (const file of files) {
        const category = (file.label ?? 'MAIN').toUpperCase()
        // Nexus files archived by the author are superseded releases, and showing the
        // raw category name would be the only untranslated heading on the tab.
        const key = category === 'ARCHIVED' ? 'OLD_VERSION' : category
        const bucket = byKey.get(key)
        if (bucket) bucket.push(file)
        else byKey.set(key, [file])
    }
    const orderedKeys = [
        ...NEXUS_CATEGORY_ORDER.filter((k) => byKey.has(k)),
        ...[...byKey.keys()].filter((k) => !NEXUS_CATEGORY_ORDER.includes(k)),
    ]
    return orderedKeys.map((key) => ({
        key,
        label: nexusCategoryLabel(key),
        files: byKey.get(key)!,
    }))
}

function DownloadsSkeleton() {
    return (
        <div className="flex flex-col gap-3 animate-pulse" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
                <div
                    key={i}
                    className="flex items-center gap-3 p-3 rounded-xl bg-surface-hover border border-border"
                >
                    <SkeletonBar className="w-14 h-14 rounded-lg bg-surface-active shrink-0" />
                    <div className="min-w-0 flex-1 flex flex-col gap-2">
                        <SkeletonBar className="h-3 w-2/5 bg-surface-active" />
                        <SkeletonBar className="h-2.5 w-3/4 bg-surface-active" />
                        <SkeletonBar className="h-2.5 w-1/3 bg-surface-active" />
                    </div>
                    <SkeletonBar className="h-8 w-24 rounded-lg bg-surface-active shrink-0" />
                    <SkeletonBar className="h-8 w-8 rounded-lg bg-surface-active shrink-0" />
                </div>
            ))}
        </div>
    )
}

export function DownloadsTab({
    modVersion,
    files,
    links,
    loading,
    mod,
    images,
    gamePath,
    installedFiles,
    activeGame,
    onRefreshInstalled,
    onOpenDetail,
    nexusUrl,
    isNexus = false,
}: {
    files: ModFile[]
    links: ModLink[]
    loading: boolean
    modVersion: string | undefined
    mod: ModSummary
    images: ModImage[]
    gamePath: string | null
    installedFiles: InstalledMod[]
    activeGame: GameId
    onRefreshInstalled: () => Promise<void>
    onOpenDetail?: (modId: number) => void
    // Set when files is still empty because nothing has resolved yet (fetch pending or
    // failed), so an empty list here reads as "not loaded", never "genuinely no files".
    // Points the user at the site instead of showing a bare "no files" message.
    nexusUrl?: string | null
    // Nexus has no per-file images (only one mod-level picture, already shown as the
    // banner) and groups files into real categories (Main/Optional/Old versions/etc.)
    // rather than a flat list, so both need a source-aware render path.
    isNexus?: boolean
}) {
    const [uninstallingId, setUninstallingId] = useState<number | null>(null)
    const [installError, setInstallError] = useState<string | null>(null)
    const [formatWarningFile, setFormatWarningFile] = useState<ModFile | null>(null)
    const crimeBossInstallTarget = useCrimeBossInstallTarget(
        activeGame,
        gamePath,
        onRefreshInstalled
    )
    const operations = useInstallOperations(activeGame)
    const modOperation = getModInstall(operations, isNexus ? 'nexus' : 'modworkshop', mod.id)
    const modBusy = isInstallBusy(modOperation)

    async function handleNexusDownloadClick(file: ModFile) {
        setInstallError(null)
        try {
            await api.requestNexusDownload(activeGame, mod.id, file.url!, file.id)
        } catch (error) {
            setInstallError(String(error))
        }
    }

    async function handleUninstallFile(file: ModFile) {
        if (!gamePath) return
        const installedMod = installedFiles.find((m) => m.fileId === file.id)
        if (!installedMod) return
        setUninstallingId(file.id)
        try {
            await api.uninstallMod(installedMod.uid, gamePath, activeGame)
            await onRefreshInstalled()
        } finally {
            setUninstallingId(null)
        }
    }

    async function handleInstallFile(file: ModFile) {
        if (isUnsupportedFormat(GAMES[activeGame], file.type, file.download_url, file.name)) {
            setFormatWarningFile(file)
            return
        }
        try {
            await crimeBossInstallTarget.runInstall(mod.id, mod.name, () => doInstallFile(file))
        } catch (error) {
            setInstallError(String(error))
        }
    }

    async function doInstallFile(file: ModFile) {
        if (!gamePath || modVersion === undefined) return
        setInstallError(null)
        try {
            const outcome = await api.installModFile(
                mod.id,
                mod.name,
                file.id,
                file.download_url,
                file.type ?? '',
                modVersion,
                gamePath,
                activeGame
            )
            await requestInstallChoice(outcome, activeGame, gamePath, installedFiles, null, mod.id)
            await onRefreshInstalled()
        } catch (e) {
            setInstallError(String(e))
        }
    }

    function renderFile(file: ModFile, thumbUrl: string | null) {
        const isInstalled = installedFiles.some((m) => m.fileId === file.id)
        const operation = getModInstall(
            operations,
            isNexus ? 'nexus' : 'modworkshop',
            mod.id,
            file.id
        )
        const isInstalling = isInstallBusy(operation)
        const isUninstalling = uninstallingId === file.id
        return (
            <div
                key={file.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-surface-hover border border-border"
            >
                {!isNexus && (
                    <div className="relative shrink-0">
                        {thumbUrl ? (
                            <img
                                src={thumbUrl}
                                alt=""
                                className="w-14 h-14 rounded-lg object-cover"
                            />
                        ) : (
                            <div className="w-14 h-14 rounded-lg bg-surface-active flex items-center justify-center">
                                <ImageIcon
                                    className="w-5 h-5 text-text-subtle"
                                    aria-hidden="true"
                                />
                            </div>
                        )}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        {file.label && !isNexus && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent font-medium uppercase tracking-wide shrink-0">
                                {file.label}
                            </span>
                        )}
                        <span className="text-sm font-semibold truncate">{file.name}</span>
                    </div>
                    {file.desc && (
                        <div className="text-xs text-text-muted mt-1 [&_a]:text-accent-bright [&_a]:hover:underline">
                            {isNexus ? (
                                <NexusDescription text={file.desc} onOpenDetail={onOpenDetail} />
                            ) : (
                                <ModworkshopMarkup text={file.desc} onOpenDetail={onOpenDetail} />
                            )}
                        </div>
                    )}
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                        {isUnsupportedFormat(
                            GAMES[activeGame],
                            file.type,
                            file.download_url,
                            file.name
                        ) && (
                            <span className="flex items-center gap-1 text-warning">
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                {t('common.nonPakWarning')}
                            </span>
                        )}
                        {file.version && (
                            <span className="flex items-center gap-1">
                                <Tag className="w-3 h-3 shrink-0" />
                                {file.version}
                            </span>
                        )}
                        {file.downloads != null && (
                            <span className="flex items-center gap-1">
                                <Download className="w-3 h-3 shrink-0" />
                                {file.downloads.toLocaleString()}
                            </span>
                        )}
                        {file.created_at && (
                            <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3 shrink-0" />
                                {formatDate(file.created_at)}
                            </span>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {file.url && !file.download_url ? (
                        isNexus && isInstalling ? (
                            <span
                                className="text-xs px-4 py-2 rounded-lg bg-accent/20 border border-accent/40 text-text"
                                role="status"
                            >
                                {installLabel(operation)}
                            </span>
                        ) : isNexus && isInstalled ? (
                            <>
                                <span className="text-xs px-4 py-2 rounded-lg bg-success/20 border border-success/40 text-success-text">
                                    {t('common.installed')}
                                </span>
                                <Tooltip content={t('common.remove')}>
                                    <Button
                                        variant="danger"
                                        size="icon-md"
                                        disabled={!gamePath || isUninstalling || modBusy}
                                        onClick={() => handleUninstallFile(file)}
                                        className="p-2 rounded-lg"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                            </>
                        ) : (
                            <Button
                                variant="accent"
                                size="lg"
                                disabled={isNexus && modBusy}
                                onClick={() =>
                                    isNexus
                                        ? handleNexusDownloadClick(file)
                                        : api.openExternal(file.url!)
                                }
                                className="py-2 rounded-lg"
                            >
                                {isNexus ? (
                                    <Download className="w-3.5 h-3.5" />
                                ) : (
                                    <ExternalLink className="w-3.5 h-3.5" />
                                )}
                                {isNexus ? t('detail.downloads.viaNexus') : t('common.openLink')}
                            </Button>
                        )
                    ) : (
                        <>
                            <button
                                disabled={
                                    !gamePath ||
                                    modVersion === undefined ||
                                    modBusy ||
                                    isInstalled ||
                                    !!mod.disable_mod_managers
                                }
                                onClick={() => handleInstallFile(file)}
                                className={`text-xs px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-1.5 ${
                                    isInstalled
                                        ? 'bg-success/20 border border-success/40 text-success-text'
                                        : 'bg-accent-fill hover:bg-accent-fill-hover disabled:opacity-40'
                                }`}
                            >
                                {!isInstalling && !isInstalled && (
                                    <Download className="w-3.5 h-3.5" />
                                )}
                                {isInstalling
                                    ? installLabel(operation)
                                    : isInstalled
                                      ? t('common.installed')
                                      : `${t('common.install')}${file.type ? ` ${file.type.toUpperCase()}` : ''} (${formatBytes(file.size)})`}
                            </button>
                            {isInstalled && (
                                <Tooltip content={t('common.remove')}>
                                    <Button
                                        variant="danger"
                                        size="icon-md"
                                        disabled={!gamePath || isUninstalling || modBusy}
                                        onClick={() => handleUninstallFile(file)}
                                        className="p-2 rounded-lg"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                            )}
                            <Tooltip content={t('detail.downloads.external')}>
                                <button
                                    onClick={() => api.openExternal(file.url ?? file.download_url)}
                                    className="p-2 rounded-lg bg-surface-active hover:bg-surface-light transition-colors"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                            </Tooltip>
                        </>
                    )}
                </div>
            </div>
        )
    }

    if (loading) {
        return <DownloadsSkeleton />
    }

    if (files.length === 0 && links.length === 0) {
        if (nexusUrl) {
            return (
                <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-text-subtle">{t('detail.downloads.onNexus')}</p>
                    <Button
                        variant="accent"
                        size="lg"
                        onClick={() => api.openExternal(nexusUrl)}
                        className="py-2 rounded-lg"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        {t('common.openLink')}
                    </Button>
                </div>
            )
        }
        return <p className="text-sm text-text-subtle">{t('detail.downloads.none')}</p>
    }

    const modThumbUrl = mod.thumbnail ? `${THUMBNAIL_BASE_URL}/${mod.thumbnail.file}` : null
    const imageMap = new Map((images ?? []).map((img) => [img.id, img]))

    return (
        <div className="flex flex-col gap-3">
            {crimeBossInstallTarget.pendingChoice && (
                <CrimeBossInstallTargetModal
                    modName={crimeBossInstallTarget.pendingChoice.modName}
                    busy={crimeBossInstallTarget.relocating}
                    error={crimeBossInstallTarget.error}
                    onChoose={crimeBossInstallTarget.confirmChoice}
                    onCancel={crimeBossInstallTarget.cancelChoice}
                />
            )}
            {formatWarningFile && (
                <NonPakConfirmModal
                    onConfirm={async () => {
                        const file = formatWarningFile!
                        setFormatWarningFile(null)
                        try {
                            await crimeBossInstallTarget.runInstall(mod.id, mod.name, () =>
                                doInstallFile(file)
                            )
                        } catch (error) {
                            setInstallError(String(error))
                        }
                    }}
                    onCancel={() => setFormatWarningFile(null)}
                />
            )}
            {(installError ?? modOperation?.error) && (
                <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                    {installError ?? modOperation?.error}
                </div>
            )}
            {isNexus
                ? groupNexusFiles(files).map((group) => (
                      <div key={group.key} className="flex flex-col gap-3">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
                              {group.label}
                          </h3>
                          {group.files.map((file) => renderFile(file, null))}
                      </div>
                  ))
                : files.map((file) => {
                      const fileImage =
                          file.image_id != null ? imageMap.get(file.image_id) : undefined
                      const thumbUrl = fileImage
                          ? `${THUMBNAIL_BASE_URL}/${fileImage.file}`
                          : modThumbUrl
                      return renderFile(file, thumbUrl)
                  })}
            {links.length > 0 && (
                <>
                    {files.length > 0 && <hr className="border-border" />}
                    {links.map((link) => {
                        const linkImage =
                            link.image_id != null ? imageMap.get(link.image_id) : undefined
                        const thumbUrl = linkImage
                            ? `${THUMBNAIL_BASE_URL}/${linkImage.file}`
                            : modThumbUrl
                        return (
                            <div
                                key={link.id}
                                className="flex items-center gap-3 p-3 rounded-xl bg-surface-hover border border-border"
                            >
                                <div className="relative shrink-0">
                                    {thumbUrl ? (
                                        <img
                                            src={thumbUrl}
                                            alt=""
                                            className="w-14 h-14 rounded-lg object-cover"
                                        />
                                    ) : (
                                        <div className="w-14 h-14 rounded-lg bg-surface-active flex items-center justify-center">
                                            <ImageIcon
                                                className="w-5 h-5 text-text-subtle"
                                                aria-hidden="true"
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <span className="text-sm font-semibold truncate block">
                                        {link.name}
                                    </span>
                                    {link.desc && (
                                        <div className="text-xs text-text-muted mt-1 [&_a]:text-accent-bright [&_a]:hover:underline">
                                            <ModworkshopMarkup
                                                text={link.desc}
                                                onOpenDetail={onOpenDetail}
                                            />
                                        </div>
                                    )}
                                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                                        {link.version && (
                                            <span className="flex items-center gap-1">
                                                <Tag className="w-3 h-3 shrink-0" />
                                                {link.version}
                                            </span>
                                        )}
                                        {link.downloads != null && (
                                            <span className="flex items-center gap-1">
                                                <Download className="w-3 h-3 shrink-0" />
                                                {link.downloads.toLocaleString()}
                                            </span>
                                        )}
                                        {link.created_at && (
                                            <span className="flex items-center gap-1">
                                                <Clock className="w-3 h-3 shrink-0" />
                                                {formatDate(link.created_at)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <Button
                                    variant="accent"
                                    size="lg"
                                    onClick={() => api.openExternal(link.url)}
                                    className="py-2 rounded-lg shrink-0"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    {t('common.openLink')}
                                </Button>
                            </div>
                        )
                    })}
                </>
            )}
        </div>
    )
}

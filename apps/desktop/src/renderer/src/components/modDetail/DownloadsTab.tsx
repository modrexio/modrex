import { useEffect, useState } from 'react'
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
import { THUMBNAIL_BASE_URL } from '../../../../shared/types'
import { api } from '../../api'
import { t } from '../../i18n'
import { isUnsupportedFormat } from '../../formatCheck'
import { handleInstallOutcome } from '../../installSentinels'
import { useCrimeBossInstallTarget } from '../../hooks/useCrimeBossInstallTarget'
import { MarkdownContent } from '../MarkdownContent'
import { Tooltip } from '../Tooltip'
import { CrimeBossInstallTargetModal } from '../CrimeBossInstallTargetModal'
import { ZipPickerModal } from '../ZipPickerModal'
import type { ZipMultiPakPayload } from '../ZipPickerModal'
import { HostPackModal } from '../HostPackModal'
import type { HostPackPayload } from '../HostPackModal'
import { CrimeBossFlatArchiveModal } from '../CrimeBossFlatArchiveModal'
import type { CbFlatArchivePayload } from '../CrimeBossFlatArchiveModal'
import { Ue4ssReplaceModal } from '../Ue4ssReplaceModal'
import type { LoaderReplacePayload } from '../Ue4ssReplaceModal'
import { UnrecognizedArchiveModal } from '../UnrecognizedArchiveModal'
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
        const key = (file.label ?? 'MAIN').toUpperCase()
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
    installed,
    installedFiles,
    downloadMap,
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
    installed: InstalledMod[]
    installedFiles: InstalledMod[]
    downloadMap: ReadonlyMap<string, { downloaded: number; total: number }>
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
    const [installingId, setInstallingId] = useState<number | null>(null)
    const [uninstallingId, setUninstallingId] = useState<number | null>(null)
    const [installError, setInstallError] = useState<string | null>(null)
    const [formatWarningFile, setFormatWarningFile] = useState<ModFile | null>(null)
    const [zipPickerData, setZipPickerData] = useState<ZipMultiPakPayload | null>(null)
    const [hostPackData, setHostPackData] = useState<HostPackPayload | null>(null)
    const [unrecognizedModId, setUnrecognizedModId] = useState<number | null>(null)
    const [cbFlatArchiveData, setCbFlatArchiveData] = useState<CbFlatArchivePayload | null>(null)
    const [loaderReplaceData, setLoaderReplaceData] = useState<LoaderReplacePayload | null>(null)
    const crimeBossInstallTarget = useCrimeBossInstallTarget(
        activeGame ?? 'pd3',
        gamePath,
        onRefreshInstalled
    )
    // Tracks the moment between clicking "Download via Nexus" (which only opens the
    // browser) and the nxm:// callback actually landing back in the app, so the click
    // has visible feedback instead of looking like it did nothing. Superseded once
    // downloadMap carries real progress for the file (see ModDetailPage), and cleared
    // on its own after a while in case the browser flow is abandoned.
    const [awaitingNxmFileId, setAwaitingNxmFileId] = useState<number | null>(null)

    useEffect(() => {
        if (!isNexus) return
        return api.onNxmInstallFailed((e) => {
            setAwaitingNxmFileId(null)
            setInstallError(e)
        })
    }, [isNexus])

    function handleNexusDownloadClick(file: ModFile) {
        setAwaitingNxmFileId(file.id)
        api.openExternal(file.url!)
        window.setTimeout(() => {
            setAwaitingNxmFileId((cur) => (cur === file.id ? null : cur))
        }, 180_000)
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

    function handleInstallFile(file: ModFile) {
        if (isUnsupportedFormat(file.type, file.download_url)) {
            setFormatWarningFile(file)
            return
        }
        crimeBossInstallTarget.runInstall(mod.id, mod.name, () => doInstallFile(file))
    }

    async function doInstallFile(file: ModFile) {
        if (!gamePath || modVersion === undefined) return
        setInstallingId(file.id)
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
            if (
                handleInstallOutcome(outcome, {
                    onZipMultiPak: setZipPickerData,
                    onHostModPack: setHostPackData,
                    onCbFlatArchive: setCbFlatArchiveData,
                    onLoaderReplace: setLoaderReplaceData,
                    onUnrecognizedArchive: () => setUnrecognizedModId(mod.id),
                })
            ) {
                return
            }
            await onRefreshInstalled()
        } catch (e) {
            setInstallError(String(e))
        } finally {
            setInstallingId(null)
        }
    }

    function renderFile(file: ModFile, thumbUrl: string | null) {
        const isInstalled = installedFiles.some((m) => m.fileId === file.id)
        const isInstalling = installingId === file.id
        const fileProgress = downloadMap.get(`file:${mod.id}:${file.id}`)
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
                            <MarkdownContent text={file.desc} onOpenDetail={onOpenDetail} />
                        </div>
                    )}
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                        {isUnsupportedFormat(file.type, file.download_url) && (
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
                        isNexus && isInstalled ? (
                            <>
                                <span className="text-xs px-4 py-2 rounded-lg bg-success/20 border border-success/40 text-success-text">
                                    {t('common.installed')}
                                </span>
                                <Tooltip content={t('common.remove')}>
                                    <Button
                                        variant="danger"
                                        size="icon-md"
                                        disabled={!gamePath || isUninstalling}
                                        onClick={() => handleUninstallFile(file)}
                                        className="p-2 rounded-lg"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                            </>
                        ) : isNexus && (awaitingNxmFileId === file.id || fileProgress) ? (
                            <span className="text-xs px-4 py-2 rounded-lg bg-accent/20 border border-accent/40 text-text">
                                {fileProgress
                                    ? fileProgress.total > 0
                                        ? `${Math.round((fileProgress.downloaded / fileProgress.total) * 100)}%`
                                        : t('common.downloading')
                                    : t('detail.downloads.awaitingNexus')}
                            </span>
                        ) : (
                            <Button
                                variant="accent"
                                size="lg"
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
                                    isInstalling ||
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
                                    ? fileProgress
                                        ? fileProgress.total > 0
                                            ? `${Math.round((fileProgress.downloaded / fileProgress.total) * 100)}%`
                                            : t('common.downloading')
                                        : t('common.installing')
                                    : isInstalled
                                      ? t('common.installed')
                                      : `${t('common.install')}${file.type ? ` ${file.type.toUpperCase()}` : ''} (${formatBytes(file.size)})`}
                            </button>
                            {isInstalled && (
                                <Tooltip content={t('common.remove')}>
                                    <Button
                                        variant="danger"
                                        size="icon-md"
                                        disabled={!gamePath || isUninstalling}
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
            {zipPickerData && gamePath && (
                <ZipPickerModal
                    payload={zipPickerData}
                    gamePath={gamePath}
                    installedFiles={installedFiles}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setZipPickerData(null)}
                />
            )}
            {hostPackData && gamePath && (
                <HostPackModal
                    payload={hostPackData}
                    gamePath={gamePath}
                    installed={installed}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setHostPackData(null)}
                />
            )}
            {cbFlatArchiveData && gamePath && (
                <CrimeBossFlatArchiveModal
                    payload={cbFlatArchiveData}
                    gamePath={gamePath}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setCbFlatArchiveData(null)}
                />
            )}
            {loaderReplaceData && gamePath && (
                <Ue4ssReplaceModal
                    payload={loaderReplaceData}
                    gameId={activeGame}
                    gamePath={gamePath}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setLoaderReplaceData(null)}
                />
            )}
            {unrecognizedModId !== null && (
                <UnrecognizedArchiveModal
                    modId={unrecognizedModId}
                    onClose={() => setUnrecognizedModId(null)}
                />
            )}
            {formatWarningFile && (
                <NonPakConfirmModal
                    onConfirm={() => {
                        const file = formatWarningFile!
                        setFormatWarningFile(null)
                        crimeBossInstallTarget.runInstall(mod.id, mod.name, () =>
                            doInstallFile(file)
                        )
                    }}
                    onCancel={() => setFormatWarningFile(null)}
                />
            )}
            {installError && (
                <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                    {installError}
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
                                            <MarkdownContent
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

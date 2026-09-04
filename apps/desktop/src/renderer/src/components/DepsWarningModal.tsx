import { useState, useEffect } from 'react'
import { Button } from './ui/Button'
import { TriangleAlert, ExternalLink } from 'lucide-react'
import type { ModDependency } from '../../../shared/types'
import { THUMBNAIL_BASE_URL } from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { api } from '../api'
import { uninstallablePromptMessage } from '../installSentinels'
import { getCachedMod } from '../modCache'
import { isLoaderDep, offsiteDepHost } from '../deps'

interface Props {
    modId: number
    missingRequired: ModDependency[]
    gamePath: string | null
    gameId: string
    loaderModIds?: number[]
    onInstallLoader?: (modId: number | null) => Promise<void>
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
    onGotIt: (permanent: boolean) => void
    onOpenDetail?: (modId: number) => void
}

export function DepsWarningModal({
    missingRequired,
    gamePath,
    gameId,
    loaderModIds,
    onInstallLoader,
    onRefreshInstalled,
    onClose,
    onGotIt,
    onOpenDetail,
}: Props) {
    const [dontShowAgain, setDontShowAgain] = useState(false)
    const [installingDeps, setInstallingDeps] = useState<Record<number, boolean>>({})
    const [installingLoader, setInstallingLoader] = useState(false)
    const [isBltUnsupported, setIsBltUnsupported] = useState(false)
    const [installingAll, setInstallingAll] = useState(false)
    const [installError, setInstallError] = useState<string | null>(null)
    const [downloadProgress, setDownloadProgress] = useState<
        Map<number, { downloaded: number; total: number }>
    >(new Map())

    useEffect(() => {
        return api.onDownloadProgress(({ download_id, downloaded, total }) => {
            const match = download_id.match(/^mod:(\d+)$/)
            if (!match) return
            const modId = Number(match[1])
            setDownloadProgress((prev) => new Map(prev).set(modId, { downloaded, total }))
        })
    }, [])

    useEffect(() => {
        if (missingRequired.length === 0) onClose()
    }, [missingRequired.length, onClose])

    useEffect(() => {
        if (gameId !== 'pd2' || !gamePath) return
        api.isPd2Diesel3(gamePath).then(setIsBltUnsupported)
    }, [gameId, gamePath])

    async function handleInstallLoader(loaderModId: number | null) {
        if (!onInstallLoader) return
        setInstallingLoader(true)
        try {
            await onInstallLoader(loaderModId)
        } finally {
            setInstallingLoader(false)
        }
    }

    async function installOneDep(dep: ModDependency) {
        if (!gamePath || dep.mod === null) return
        const isLoaderMod = !!loaderModIds?.includes(dep.mod.id)
        if (isLoaderMod) return handleInstallLoader(dep.mod.id)
        setInstallingDeps((prev) => ({ ...prev, [dep.mod!.id]: true }))
        try {
            const fullMod = await getCachedMod(dep.mod.id)
            if (fullMod.download?.url && !fullMod.download.download_url) {
                api.openExternal(fullMod.download.url)
                return
            }
            const outcome = await api.installMod(dep.mod.id, gamePath, gameId)
            const blocked = uninstallablePromptMessage(outcome)
            if (blocked) {
                setInstallError(blocked)
                return
            }
            await onRefreshInstalled()
        } finally {
            setInstallingDeps((prev) => ({ ...prev, [dep.mod!.id]: false }))
        }
    }

    async function handleInstallAll() {
        setInstallingAll(true)
        setInstallError(null)
        const installable = missingRequired.filter(
            (dep) => dep.mod !== null && dep.mod.has_download && gamePath
        )
        try {
            for (const dep of installable) {
                await installOneDep(dep)
            }
        } catch (e) {
            setInstallError(String(e))
        } finally {
            setInstallingAll(false)
        }
    }

    const installableCount = missingRequired.filter(
        (dep) => dep.mod !== null && dep.mod.has_download && !!gamePath
    ).length

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onClose()}
            title={t('depsWarning.title')}
            className="w-[480px]"
        >
            <DialogHeader
                title={t('depsWarning.title')}
                subtitle={t('depsWarning.body')}
                icon={<TriangleAlert className="w-4 h-4 text-warning shrink-0" />}
                onClose={onClose}
                wrapSubtitle
            />
            <div className="p-6 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    {missingRequired
                        .filter((dep) => dep.mod === null && !!dep.url)
                        .map((dep) => (
                            <div
                                key={dep.id}
                                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover border border-border"
                            >
                                <div className="w-8 h-8 rounded bg-surface-active shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-medium truncate">
                                        {dep.name ?? offsiteDepHost(dep.url!)}
                                    </div>
                                    <div className="text-xs text-text-subtle">
                                        {isBltUnsupported && isLoaderDep(dep)
                                            ? t('depsWarning.bltDiesel3Note')
                                            : offsiteDepHost(dep.url!)}
                                    </div>
                                </div>
                                {isLoaderDep(dep) && isBltUnsupported ? (
                                    <Button
                                        variant="accent"
                                        size="md"
                                        onClick={() =>
                                            api.openExternal(
                                                'https://github.com/diesel-modding/PAYDAY2-SuperBLT'
                                            )
                                        }
                                        className="shrink-0"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        {t('depsWarning.bltDiesel3GitHub')}
                                    </Button>
                                ) : isLoaderDep(dep) && gamePath && onInstallLoader ? (
                                    <Button
                                        variant="accent"
                                        size="md"
                                        disabled={installingLoader}
                                        onClick={() => handleInstallLoader(null)}
                                        className="shrink-0"
                                    >
                                        {installingLoader
                                            ? t('common.installing')
                                            : t('common.install')}
                                    </Button>
                                ) : (
                                    <Button
                                        variant="accent"
                                        size="md"
                                        onClick={() => api.openExternal(dep.url!)}
                                        className="shrink-0"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        {t('common.openLink')}
                                    </Button>
                                )}
                            </div>
                        ))}
                    {missingRequired
                        .filter((dep) => dep.mod !== null)
                        .map((dep) => {
                            const isLoaderMod = !!loaderModIds?.includes(dep.mod!.id)
                            const thumbUrl = dep.mod!.thumbnail
                                ? `${THUMBNAIL_BASE_URL}/${dep.mod!.thumbnail.file}`
                                : null
                            const isInstalling = isLoaderMod
                                ? installingLoader
                                : installingDeps[dep.mod!.id]
                            const progress = downloadProgress.get(dep.mod!.id) ?? null
                            const progressPct =
                                isInstalling && progress && progress.total > 0
                                    ? Math.round((progress.downloaded / progress.total) * 100)
                                    : null
                            return (
                                <div
                                    key={dep.id}
                                    className="relative overflow-hidden flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover border border-border"
                                >
                                    {thumbUrl ? (
                                        <img
                                            src={thumbUrl}
                                            alt={dep.mod!.name}
                                            loading="lazy"
                                            className="w-8 h-8 rounded object-cover shrink-0"
                                        />
                                    ) : (
                                        <div className="w-8 h-8 rounded bg-surface-active shrink-0" />
                                    )}
                                    {onOpenDetail ? (
                                        <button
                                            className="min-w-0 flex-1 text-left hover:opacity-75 transition-opacity"
                                            onClick={() => {
                                                onOpenDetail(dep.mod!.id)
                                                onClose()
                                            }}
                                        >
                                            <div className="text-xs font-medium truncate">
                                                {dep.mod!.name}
                                            </div>
                                            <div className="text-xs text-text-subtle">
                                                {t('common.by', { name: dep.mod!.user.name })}
                                            </div>
                                        </button>
                                    ) : (
                                        <div className="min-w-0 flex-1">
                                            <div className="text-xs font-medium truncate">
                                                {dep.mod!.name}
                                            </div>
                                            <div className="text-xs text-text-subtle">
                                                {t('common.by', { name: dep.mod!.user.name })}
                                            </div>
                                        </div>
                                    )}
                                    {dep.mod!.has_download && gamePath && (
                                        <Button
                                            variant="accent"
                                            size="md"
                                            disabled={isInstalling || installingAll}
                                            onClick={() => {
                                                setInstallError(null)
                                                installOneDep(dep).catch((e) =>
                                                    setInstallError(String(e))
                                                )
                                            }}
                                            className="shrink-0"
                                        >
                                            {isInstalling
                                                ? progressPct !== null
                                                    ? `${progressPct}%`
                                                    : progress
                                                      ? t('common.downloading')
                                                      : t('common.installing')
                                                : t('common.install')}
                                        </Button>
                                    )}
                                    {isInstalling && progress !== null && (
                                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-active">
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
                        })}
                </div>
                {installError && (
                    <p className="text-xs text-danger">{t('depsWarning.installFailed')}</p>
                )}
                <div className="flex items-center justify-between">
                    <div
                        className="flex items-center gap-2 cursor-pointer select-none"
                        onClick={() => setDontShowAgain((v) => !v)}
                    >
                        <input
                            type="checkbox"
                            checked={dontShowAgain}
                            onChange={() => {}}
                            className="pointer-events-none"
                        />
                        <span className="text-xs text-text-muted">{t('common.dontShowAgain')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {installableCount >= 2 && (
                            <Button
                                variant="secondary"
                                size="lg"
                                disabled={
                                    installingAll || Object.values(installingDeps).some(Boolean)
                                }
                                onClick={handleInstallAll}
                            >
                                {installingAll
                                    ? t('common.installing')
                                    : t('depsWarning.installAll')}
                            </Button>
                        )}
                        <Button variant="accent" size="lg" onClick={() => onGotIt(dontShowAgain)}>
                            {t('depsWarning.gotIt')}
                        </Button>
                    </div>
                </div>
            </div>
        </Dialog>
    )
}

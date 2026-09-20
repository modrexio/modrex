import { useEffect, useState } from 'react'
import { Download, ExternalLink, Image as ImageIcon } from 'lucide-react'
import { Button } from '../ui/Button'
import type {
    ModDependency,
    InstalledMod,
    GameId,
    InstructsTemplate,
} from '../../../../shared/types'
import { MarkdownContent } from '../MarkdownContent'
import { Tooltip } from '../Tooltip'
import { t } from '../../i18n'
import { useThumbnail } from '../../hooks/useThumbnail'
import { isLoaderDep, offsiteDepHost } from '../../deps'
import { uninstallablePromptMessage } from '../../installSentinels'
import { api } from '../../api'
import { useModVersions } from '../../hooks/useModVersions'

export function DepsTab({
    instructions,
    instructsTemplate,
    deps,
    installed,
    gamePath,
    activeGame,
    loaderInstalled,
    loaderModIds,
    onInstallLoader,
    onRefreshInstalled,
    onOpenDetail,
}: {
    instructions: string | null
    instructsTemplate: InstructsTemplate | null
    deps: ModDependency[]
    installed: InstalledMod[]
    gamePath: string | null
    activeGame: GameId
    loaderInstalled: boolean | null
    // Hosted loaders (PDTHModOverrides, DAHM, UE4SS, RAID-SuperBLT) are on-site deps but aren't
    // tracked in the installed list, so their per-id presence state lives here instead.
    loaderModIds: Record<number, boolean | null>
    onInstallLoader?: (modId: number | null) => Promise<void>
    onRefreshInstalled: () => Promise<void>
    onOpenDetail?: (modId: number) => void
}) {
    const hasInstructions = !!(instructsTemplate?.instructions || instructions)
    const versions = useModVersions(deps.flatMap((dep) => (dep.mod ? [dep.mod.id] : [])))
    const knownVersion = (id: number | undefined) => {
        if (id === undefined) return undefined
        const state = versions.get(id)
        return state?.status === 'known' ? state.version : undefined
    }
    // Checked once for the whole list rather than per row.
    const [bltDiesel3, setBltDiesel3] = useState(false)
    useEffect(() => {
        if (activeGame !== 'pd2' || !gamePath) return
        api.isPd2Diesel3(gamePath).then(setBltDiesel3)
    }, [activeGame, gamePath])

    return (
        <div className="flex flex-col gap-8">
            {deps.length > 0 && (
                <section>
                    <h2 className="text-sm font-semibold mb-3 text-text">
                        {t('detail.deps.dependencies')}
                    </h2>
                    <div className="flex flex-col gap-2">
                        {deps.map((dep, i) => (
                            <DepRow
                                version={knownVersion(dep.mod?.id)}
                                key={dep.id}
                                dep={dep}
                                position={deps.length > 1 ? i + 1 : undefined}
                                installed={installed}
                                gamePath={gamePath}
                                activeGame={activeGame}
                                loaderInstalled={loaderInstalled}
                                bltDiesel3={bltDiesel3}
                                loaderModIds={loaderModIds}
                                onInstallLoader={onInstallLoader}
                                onRefreshInstalled={onRefreshInstalled}
                                onOpenDetail={onOpenDetail}
                            />
                        ))}
                    </div>
                </section>
            )}

            {hasInstructions && (
                <section>
                    <h2 className="text-sm font-semibold mb-3 text-text">
                        {t('detail.deps.instructions')}
                    </h2>
                    {instructsTemplate?.instructions && (
                        <MarkdownContent
                            text={instructsTemplate.instructions}
                            onOpenDetail={onOpenDetail}
                        />
                    )}
                    {instructions && (
                        <div className="mt-3">
                            <MarkdownContent text={instructions} onOpenDetail={onOpenDetail} />
                        </div>
                    )}
                </section>
            )}
        </div>
    )
}

function DepRow({
    version,
    dep,
    position,
    installed,
    gamePath,
    activeGame,
    loaderInstalled,
    bltDiesel3,
    loaderModIds,
    onInstallLoader,
    onRefreshInstalled,
    onOpenDetail,
}: {
    version: string | undefined
    dep: ModDependency
    position?: number
    installed: InstalledMod[]
    gamePath: string | null
    activeGame: GameId
    loaderInstalled: boolean | null
    bltDiesel3: boolean
    loaderModIds: Record<number, boolean | null>
    onInstallLoader?: (modId: number | null) => Promise<void>
    onRefreshInstalled: () => Promise<void>
    onOpenDetail?: (modId: number) => void
}) {
    const [installing, setInstalling] = useState(false)
    // A dependency row has no picker UI, so an outcome needing a choice is surfaced here
    // rather than silently doing nothing.
    const [installNote, setInstallNote] = useState<string | null>(null)
    const thumbSrc = useThumbnail(dep.mod?.thumbnail?.file)
    const { mod } = dep
    if (!mod) {
        if (!dep.url) return null
        const status = isLoaderDep(dep) ? loaderInstalled : null
        // On PD2's Diesel 3.0 branch official SuperBLT does not work, so check_loader can
        // only ever answer false - offering Install would install a DLL that stays
        // unusable. Point at the community build instead, mirroring DepsWarningModal.
        const bltUnsupported = isLoaderDep(dep) && bltDiesel3
        const canInstallLoader =
            status === false && !bltUnsupported && !!gamePath && !!onInstallLoader

        async function handleInstallLoader(e: React.MouseEvent) {
            e.stopPropagation()
            setInstalling(true)
            try {
                await onInstallLoader!(null)
            } finally {
                setInstalling(false)
            }
        }

        return (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-hover border border-border">
                {position !== undefined && (
                    <span className="w-4 text-xs text-text-subtle text-right shrink-0">
                        {position}
                    </span>
                )}
                <div className="w-10 h-10 rounded bg-surface-active shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                        {dep.name ?? offsiteDepHost(dep.url)}
                    </div>
                    <div className="text-xs text-text-subtle mt-0.5">
                        {bltUnsupported ? t('depsWarning.bltDiesel3Note') : offsiteDepHost(dep.url)}
                        {status !== null && !bltUnsupported && (
                            <>
                                {' · '}
                                <span className={status ? 'text-success-text' : 'text-danger-text'}>
                                    {status
                                        ? t('detail.deps.statusInstalled')
                                        : dep.optional
                                          ? t('detail.deps.statusNotInstalled')
                                          : t('detail.deps.statusMissing')}
                                </span>
                            </>
                        )}
                    </div>
                </div>
                <span
                    className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                        dep.optional
                            ? 'border-surface-light text-text-subtle'
                            : 'border-accent/40 text-accent'
                    }`}
                >
                    {dep.optional ? t('detail.deps.badgeOptional') : t('detail.deps.badgeRequired')}
                </span>
                {bltUnsupported ? (
                    <Button
                        variant="accent"
                        size="md"
                        onClick={() =>
                            api.openExternal('https://github.com/diesel-modding/PAYDAY2-SuperBLT')
                        }
                        className="shrink-0"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        {t('depsWarning.bltDiesel3GitHub')}
                    </Button>
                ) : canInstallLoader ? (
                    <>
                        <Button
                            variant="accent"
                            size="md"
                            disabled={installing}
                            onClick={handleInstallLoader}
                            className="shrink-0"
                        >
                            {!installing && <Download className="w-3.5 h-3.5" />}
                            {installing ? t('common.installing') : t('common.install')}
                        </Button>
                        <Tooltip content={offsiteDepHost(dep.url)}>
                            <button
                                onClick={() => api.openExternal(dep.url!)}
                                className="p-1.5 rounded text-text-subtle hover:text-text hover:bg-surface-active transition-colors shrink-0"
                            >
                                <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                        </Tooltip>
                    </>
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
        )
    }
    // Hosted loaders (RAID-SuperBLT, PDTHModOverrides, DAHM, UE4SS) are on-site deps but live in
    // the game root as DLLs, not the installed-mods list, so presence comes from loaderModIds
    // (null = not yet checked). Falling through to the installed-list check would always read
    // "Missing" for an installed loader.
    const isHostedLoader = mod.id in loaderModIds
    const depIdStr = String(mod.id)
    const isInstalled = isHostedLoader
        ? loaderModIds[mod.id] === true
        : installed.some(
              (m) => (!m.source || m.source === 'modworkshop') && m.remoteId === depIdStr
          )

    async function handleInstall(e: React.MouseEvent) {
        e.stopPropagation()
        if (!gamePath) return
        setInstalling(true)
        setInstallNote(null)
        try {
            if (isHostedLoader && onInstallLoader) {
                // Loaders install via a dedicated command (extraction to game root/Binaries),
                // never the normal mod-install flow.
                await onInstallLoader(mod!.id)
            } else {
                const outcome = await api.installMod(mod!.id, gamePath, activeGame)
                const blocked = uninstallablePromptMessage(outcome)
                if (blocked) {
                    setInstallNote(blocked)
                    return
                }
                await onRefreshInstalled()
            }
        } finally {
            setInstalling(false)
        }
    }

    return (
        <div
            role={onOpenDetail ? 'button' : undefined}
            tabIndex={onOpenDetail ? 0 : undefined}
            onClick={() => onOpenDetail?.(mod.id)}
            onKeyDown={(e) => e.key === 'Enter' && onOpenDetail?.(mod.id)}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-hover border border-border transition-colors ${
                onOpenDetail ? 'cursor-pointer hover:border-accent/50 hover:bg-surface-raised' : ''
            }`}
        >
            {position !== undefined && (
                <span className="w-4 text-xs text-text-subtle text-right shrink-0">{position}</span>
            )}
            {thumbSrc ? (
                <img
                    src={thumbSrc}
                    alt={mod.name}
                    loading="lazy"
                    className="w-10 h-10 rounded object-cover shrink-0"
                />
            ) : (
                <div className="w-10 h-10 rounded bg-surface-active shrink-0 flex items-center justify-center">
                    <ImageIcon className="w-4 h-4 text-text-subtle" aria-hidden="true" />
                </div>
            )}
            <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{mod.name}</div>
                <div className="text-xs text-text-subtle mt-0.5">
                    {t('common.by', { name: mod.user.name })}
                    {version && <> · {version}</>} ·{' '}
                    <span className={isInstalled ? 'text-success-text' : 'text-danger-text'}>
                        {isInstalled
                            ? t('detail.deps.statusInstalled')
                            : dep.optional
                              ? t('detail.deps.statusNotInstalled')
                              : t('detail.deps.statusMissing')}
                    </span>
                </div>
                {installNote && <div className="text-xs text-warning mt-0.5">{installNote}</div>}
            </div>
            <span
                className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                    dep.optional
                        ? 'border-surface-light text-text-subtle'
                        : 'border-accent/40 text-accent'
                }`}
            >
                {dep.optional ? t('detail.deps.badgeOptional') : t('detail.deps.badgeRequired')}
            </span>
            {!isInstalled && mod.has_download && !mod.disable_mod_managers && gamePath && (
                <Button
                    variant="accent"
                    size="md"
                    disabled={installing}
                    onClick={handleInstall}
                    className="shrink-0"
                >
                    {!installing && <Download className="w-3.5 h-3.5" />}
                    {installing ? t('common.installing') : t('common.install')}
                </Button>
            )}
            <Tooltip content={t('detail.deps.openOnSite')}>
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        api.openExternal(`https://modworkshop.net/mod/${mod.id}`)
                    }}
                    className="p-1.5 rounded text-text-subtle hover:text-text hover:bg-surface-active transition-colors shrink-0"
                >
                    <ExternalLink className="w-3.5 h-3.5" />
                </button>
            </Tooltip>
        </div>
    )
}

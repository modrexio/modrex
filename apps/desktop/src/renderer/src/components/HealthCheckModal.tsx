import { ScrollArea } from './ScrollArea'
import { useState, type ReactNode } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from './ui/Button'
import * as Tabs from '@radix-ui/react-tabs'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import {
    computeHealthSummary,
    detailNavArgs,
    hasCatalogLink,
    syntheticMod,
} from '../hooks/installedUtils'
import type { InstalledGroup } from '../hooks/installedUtils'
import type { HealthItem, MissingDepRef } from '../hooks/healthCheck'
import type { InstalledMod, ModSummary } from '../../../shared/types'
import { useThumbnail } from '../hooks/useThumbnail'
import { api, type LeftoverFiles } from '../api'
import { uninstallablePromptMessage } from '../installSentinels'
import { formatBytes } from './modDetail/format'
import { describeFailures, type ActionFailure } from '../bulkAction'
import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'

export interface Leftovers {
    sets: LeftoverFiles[]
    error: string | null
}

function leftoverKey(l: LeftoverFiles): string {
    return `${l.target}|${l.disabled}|${l.folder}|${l.stem}`
}

interface LocalHealthItem {
    id: number
    uid: string
    name: string
    mods: InstalledMod[]
}

interface Props {
    updateVersions: ReadonlyMap<number, string>
    installed: InstalledMod[]
    updatable: InstalledMod[]
    modData: Map<number, ModSummary>
    missingDeps: HealthItem[]
    showDepsTab: boolean
    leftovers: Leftovers
    onLeftoversChanged: () => Promise<void>
    gamePath: string | null
    gameId: string
    loadingMod: string | null
    visible: boolean
    onOpenDetail: (modId: number, source?: 'nexus') => void
    onReinstall: (mods: InstalledMod[]) => Promise<string | null>
    onDepInstalled: () => Promise<void>
    onReviewUpdates: () => void
    onClose: () => void
}

function HealthRow({
    thumbnailFile,
    source,
    name,
    secondary,
    clickable,
    onOpen,
    action,
}: {
    thumbnailFile?: string | null
    source?: InstalledMod['source']
    name: string
    secondary?: string
    clickable?: boolean
    onOpen?: () => void
    action?: ReactNode
}) {
    const thumbSrc = useThumbnail(thumbnailFile)
    return (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors">
            <div className="w-9 h-9 rounded shrink-0 bg-surface-active overflow-hidden flex items-center justify-center">
                {thumbSrc ? (
                    <img src={thumbSrc} alt="" className="w-full h-full object-cover" />
                ) : source === 'nexus' ? (
                    <NexusIcon className="w-4 h-4 text-text-subtle" />
                ) : (
                    <ImageIcon className="w-4 h-4 text-text-subtle" aria-hidden="true" />
                )}
            </div>
            <button
                disabled={!clickable}
                onClick={onOpen}
                className={`min-w-0 flex-1 text-left disabled:opacity-100 ${clickable ? 'hover:opacity-80 transition-opacity' : 'cursor-default'}`}
            >
                <div className="text-sm truncate">{name}</div>
                {secondary && <div className="text-xs text-text-subtle truncate">{secondary}</div>}
            </button>
            {action}
        </div>
    )
}

function UpdateRow({
    version,
    ins,
    apiMod,
    onOpenDetail,
}: {
    version: string
    ins: InstalledMod
    apiMod: ModSummary
    onOpenDetail: (id: number, source?: 'nexus') => void
}) {
    const thumbSrc = useThumbnail(apiMod.thumbnail?.file)
    const hasVersion = !!ins.version
    const versionLine = hasVersion
        ? t('installed.updatesModal.versionChange', { from: ins.version, to: version })
        : t('installed.updatesModal.versionAvailable', { version })
    return (
        <button
            onClick={() => onOpenDetail(...detailNavArgs(ins))}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-left"
        >
            <div className="w-9 h-9 rounded shrink-0 bg-surface-active overflow-hidden flex items-center justify-center">
                {thumbSrc ? (
                    <img src={thumbSrc} alt="" className="w-full h-full object-cover" />
                ) : ins.source === 'nexus' ? (
                    <NexusIcon className="w-4 h-4 text-text-subtle" />
                ) : (
                    <ImageIcon className="w-4 h-4 text-text-subtle" aria-hidden="true" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{apiMod.name}</div>
                <div className="text-xs text-text-subtle truncate">{versionLine}</div>
            </div>
        </button>
    )
}

function EmptyTab({ children }: { children: string }) {
    return <p className="text-sm text-text-subtle px-3 py-2">{children}</p>
}

export function HealthCheckModal({
    updateVersions,
    installed,
    updatable,
    modData,
    missingDeps,
    showDepsTab,
    leftovers,
    onLeftoversChanged,
    gamePath,
    gameId,
    loadingMod,
    visible,
    onOpenDetail,
    onReinstall,
    onDepInstalled,
    onReviewUpdates,
    onClose,
}: Props) {
    const summary = computeHealthSummary(installed)
    const [installingDepId, setInstallingDepId] = useState<number | null>(null)
    const [installingAll, setInstallingAll] = useState(false)
    const [depInstallError, setDepInstallError] = useState<string | null>(null)
    // A delete asks twice: the first click arms it, the second deletes.
    const [armedLeftover, setArmedLeftover] = useState<string | null>(null)
    const [deletingLeftovers, setDeletingLeftovers] = useState(false)
    const [leftoverError, setLeftoverError] = useState<string | null>(null)

    async function deleteLeftovers(sets: LeftoverFiles[]) {
        setDeletingLeftovers(true)
        setLeftoverError(null)
        try {
            await api.deleteLeftoverFiles(sets, gameId)
        } catch (e) {
            setLeftoverError(t('installed.health.deleteLeftoversFailed', { error: String(e) }))
        } finally {
            setArmedLeftover(null)
            setDeletingLeftovers(false)
        }
        await onLeftoversChanged()
    }

    const [reinstalling, setReinstalling] = useState(false)
    const [reinstallFailure, setReinstallFailure] = useState<string | null>(null)

    // One at a time: reinstalls share one loading slot, and every failure is kept to show here.
    async function reinstallItems(items: LocalHealthItem[]) {
        setReinstalling(true)
        setReinstallFailure(null)
        const failures: ActionFailure[] = []
        for (const item of items) {
            try {
                const failure = await onReinstall(item.mods)
                if (failure) failures.push({ name: item.name, error: failure })
            } catch (e) {
                failures.push({ name: item.name, error: String(e) })
            }
        }
        setReinstalling(false)
        setReinstallFailure(describeFailures(failures))
    }

    async function installDep(depId: number) {
        if (!gamePath || installingDepId !== null || installingAll) return
        setInstallingDepId(depId)
        setDepInstallError(null)
        try {
            const outcome = await api.installMod(depId, gamePath, gameId)
            const blocked = uninstallablePromptMessage(outcome)
            if (blocked) {
                setDepInstallError(blocked)
                return
            }
            await onDepInstalled()
        } catch {
            setDepInstallError(t('installed.health.installDepFailed'))
        } finally {
            setInstallingDepId(null)
        }
    }

    async function installAllDeps() {
        if (!gamePath || installingAll || installingDepId !== null) return
        const uniqueDepIds = [
            ...new Set(
                missingDeps.flatMap((item) =>
                    (item.missingDeps ?? [])
                        .filter((d): d is MissingDepRef & { id: number } => d.id !== null)
                        .map((d) => d.id)
                )
            ),
        ]
        if (uniqueDepIds.length === 0) return
        setInstallingAll(true)
        setDepInstallError(null)
        let hadError = false
        let blockedMessage: string | null = null
        for (const depId of uniqueDepIds) {
            try {
                const outcome = await api.installMod(depId, gamePath, gameId)
                blockedMessage = blockedMessage ?? uninstallablePromptMessage(outcome)
            } catch {
                hadError = true
            }
        }
        await onDepInstalled().catch(() => {})
        setInstallingAll(false)
        if (hadError || blockedMessage) {
            setDepInstallError(hadError ? t('installed.health.installDepFailed') : blockedMessage)
        }
    }

    function toItems(groups: InstalledGroup[]): LocalHealthItem[] {
        return groups.map((g) => ({ id: g.id, uid: g.key, name: g.mods[0].name, mods: g.mods }))
    }

    const missingItems = toItems(summary.missing)
    const brokenItems = toItems(summary.archiveBroken)
    const outdatedItems = toItems(summary.outdated)
    const unidentifiedItems = toItems(summary.unidentified)

    // Lifted out of Tabs.Root (which Radix unmounts along with the rest of Dialog.Content
    // while !visible) so the selected tab survives navigating to a mod's detail page and back.
    const [activeTab, setActiveTab] = useState(() => (showDepsTab ? 'deps' : 'missing'))

    const tabs: { id: string; label: string }[] = [
        ...(showDepsTab
            ? [
                  {
                      id: 'deps',
                      label: t('installed.health.dependenciesCount', { count: missingDeps.length }),
                  },
              ]
            : []),
        {
            id: 'missing',
            label: t('installed.health.missingFilesCount', { count: missingItems.length }),
        },
        {
            id: 'broken',
            label: t('installed.health.brokenArchivesCount', { count: brokenItems.length }),
        },
        {
            id: 'outdated',
            label: t('installed.health.outdatedCount', { count: outdatedItems.length }),
        },
        {
            id: 'unidentified',
            label: t('installed.health.unidentifiedCount', { count: unidentifiedItems.length }),
        },
        {
            id: 'leftovers',
            label: t('installed.health.leftoversCount', { count: leftovers.sets.length }),
        },
        {
            id: 'updates',
            label: t('installed.health.updatesCount', { count: updatable.length }),
        },
    ]

    function leftoversContent() {
        if (leftovers.error !== null) {
            return (
                <EmptyTab>
                    {t('installed.health.leftoversLoadFailed', { error: leftovers.error })}
                </EmptyTab>
            )
        }
        if (leftovers.sets.length === 0) {
            return <EmptyTab>{t('installed.health.noLeftovers')}</EmptyTab>
        }
        return leftovers.sets.map((l) => {
            const key = leftoverKey(l)
            const armed = armedLeftover === key
            return (
                <HealthRow
                    key={key}
                    name={l.folder ? `${l.folder}/${l.stem}` : l.stem}
                    secondary={t('installed.health.leftoverHint', {
                        files: l.files.join(', '),
                        size: formatBytes(l.bytes),
                    })}
                    action={
                        <Button
                            variant={armed ? 'danger' : 'secondary'}
                            size="sm"
                            disabled={deletingLeftovers}
                            onClick={() =>
                                armed ? void deleteLeftovers([l]) : setArmedLeftover(key)
                            }
                            className="px-2.5 shrink-0"
                        >
                            {armed
                                ? t('installed.health.confirmDelete')
                                : t('installed.health.deleteLeftover')}
                        </Button>
                    }
                />
            )
        })
    }

    return (
        <Dialog
            open={visible}
            onOpenChange={(open) => !open && onClose()}
            title={t('installed.health.title')}
            size="panel"
            className="w-[48rem]"
        >
            <DialogHeader title={t('installed.health.title')} onClose={onClose} />

            <Tabs.Root
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex flex-col flex-1 min-h-0"
            >
                <ScrollArea hostClassName="shrink-0" className="overflow-x-auto">
                    <Tabs.List className="flex border-b border-border px-5">
                        {tabs.map((tabItem) => (
                            <Tabs.Trigger
                                key={tabItem.id}
                                value={tabItem.id}
                                className="relative text-xs px-2.5 py-3 border-b-2 border-transparent transition-colors text-text-subtle hover:text-text-muted before:content-[''] before:absolute before:inset-x-1 before:inset-y-1.5 before:rounded before:transition-colors hover:before:bg-surface-hover data-[state=active]:border-accent data-[state=active]:text-accent focus:outline-none whitespace-nowrap"
                            >
                                <span className="relative">{tabItem.label}</span>
                            </Tabs.Trigger>
                        ))}
                    </Tabs.List>
                </ScrollArea>

                <ScrollArea hostClassName="flex-1" className="overflow-y-auto p-3">
                    {showDepsTab && (
                        <Tabs.Content
                            value="deps"
                            className="focus:outline-none flex flex-col gap-0.5"
                        >
                            {missingDeps.length === 0 ? (
                                <EmptyTab>{t('installed.health.noMissingDeps')}</EmptyTab>
                            ) : (
                                missingDeps.map((item) => {
                                    const resolvable = item.missingDeps?.find(
                                        (d): d is MissingDepRef & { id: number } => d.id !== null
                                    )
                                    const isInstalling = installingDepId === resolvable?.id
                                    return (
                                        <HealthRow
                                            key={item.uid}
                                            thumbnailFile={modData.get(item.id)?.thumbnail?.file}
                                            name={item.name}
                                            secondary={
                                                item.missingDeps?.length
                                                    ? t('installed.health.missingDepsHint', {
                                                          deps: item.missingDeps
                                                              .map((d) => d.name)
                                                              .join(', '),
                                                      })
                                                    : undefined
                                            }
                                            clickable
                                            onOpen={() => onOpenDetail(item.id)}
                                            action={
                                                resolvable ? (
                                                    <Button
                                                        variant="accent"
                                                        size="sm"
                                                        disabled={
                                                            !gamePath ||
                                                            isInstalling ||
                                                            installingAll
                                                        }
                                                        onClick={() =>
                                                            void installDep(resolvable.id)
                                                        }
                                                        className="px-2.5 shrink-0"
                                                    >
                                                        {isInstalling
                                                            ? t('common.installing')
                                                            : t('installed.health.installDep')}
                                                    </Button>
                                                ) : undefined
                                            }
                                        />
                                    )
                                })
                            )}
                        </Tabs.Content>
                    )}
                    <Tabs.Content
                        value="missing"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {missingItems.length === 0 ? (
                            <EmptyTab>{t('installed.health.noMissingFiles')}</EmptyTab>
                        ) : (
                            missingItems.map((item) => {
                                const isLoading =
                                    loadingMod !== null &&
                                    item.mods.some((m) => m.uid === loadingMod)
                                return (
                                    <HealthRow
                                        key={item.uid}
                                        thumbnailFile={modData.get(item.id)?.thumbnail?.file}
                                        source={item.mods[0]?.source}
                                        name={item.name}
                                        secondary={
                                            item.mods.some((m) => m.missing)
                                                ? t('installed.health.missingFileHint')
                                                : t('installed.health.containerMissingHint')
                                        }
                                        clickable={hasCatalogLink(item.mods[0])}
                                        onOpen={
                                            hasCatalogLink(item.mods[0])
                                                ? () => onOpenDetail(...detailNavArgs(item.mods[0]))
                                                : undefined
                                        }
                                        action={
                                            hasCatalogLink(item.mods[0]) ? (
                                                <button
                                                    onClick={() => void reinstallItems([item])}
                                                    disabled={isLoading || reinstalling}
                                                    className="text-xs px-2.5 py-1 rounded bg-surface-active hover:bg-surface-light shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    {isLoading
                                                        ? t('common.installing')
                                                        : t('common.reinstall')}
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                )
                            })
                        )}
                    </Tabs.Content>
                    <Tabs.Content
                        value="broken"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {brokenItems.length === 0 ? (
                            <EmptyTab>{t('installed.health.noBrokenArchives')}</EmptyTab>
                        ) : (
                            brokenItems.map((item) => {
                                const isLoading =
                                    loadingMod !== null &&
                                    item.mods.some((m) => m.uid === loadingMod)
                                return (
                                    <HealthRow
                                        key={item.uid}
                                        thumbnailFile={modData.get(item.id)?.thumbnail?.file}
                                        source={item.mods[0]?.source}
                                        name={item.name}
                                        secondary={t('installed.health.brokenArchiveHint')}
                                        clickable={hasCatalogLink(item.mods[0])}
                                        onOpen={
                                            hasCatalogLink(item.mods[0])
                                                ? () => onOpenDetail(...detailNavArgs(item.mods[0]))
                                                : undefined
                                        }
                                        action={
                                            hasCatalogLink(item.mods[0]) ? (
                                                <button
                                                    onClick={() => void reinstallItems([item])}
                                                    disabled={isLoading || reinstalling}
                                                    className="text-xs px-2.5 py-1 rounded bg-surface-active hover:bg-surface-light shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    {isLoading
                                                        ? t('common.installing')
                                                        : t('common.reinstall')}
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                )
                            })
                        )}
                    </Tabs.Content>
                    <Tabs.Content
                        value="outdated"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {outdatedItems.length === 0 ? (
                            <EmptyTab>{t('installed.health.noOutdated')}</EmptyTab>
                        ) : (
                            outdatedItems.map((item) => {
                                const isLoading =
                                    loadingMod !== null &&
                                    item.mods.some((m) => m.uid === loadingMod)
                                return (
                                    <HealthRow
                                        key={item.uid}
                                        thumbnailFile={modData.get(item.id)?.thumbnail?.file}
                                        source={item.mods[0]?.source}
                                        name={item.name}
                                        secondary={t('installed.health.outdatedHint')}
                                        clickable
                                        onOpen={() => onOpenDetail(...detailNavArgs(item.mods[0]))}
                                        action={
                                            <button
                                                onClick={() => void reinstallItems([item])}
                                                disabled={isLoading || reinstalling}
                                                className="text-xs px-2.5 py-1 rounded bg-surface-active hover:bg-surface-light shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                {isLoading
                                                    ? t('common.installing')
                                                    : t('common.reinstall')}
                                            </button>
                                        }
                                    />
                                )
                            })
                        )}
                    </Tabs.Content>
                    <Tabs.Content
                        value="unidentified"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {unidentifiedItems.length === 0 ? (
                            <EmptyTab>{t('installed.health.noUnidentified')}</EmptyTab>
                        ) : (
                            unidentifiedItems.map((item) => (
                                <HealthRow
                                    key={item.uid}
                                    source={item.mods[0]?.source}
                                    name={item.name}
                                    secondary={t('installed.health.unidentifiedRowHint')}
                                />
                            ))
                        )}
                    </Tabs.Content>
                    <Tabs.Content
                        value="leftovers"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {leftoversContent()}
                    </Tabs.Content>
                    <Tabs.Content
                        value="updates"
                        className="focus:outline-none flex flex-col gap-0.5"
                    >
                        {updatable.length === 0 ? (
                            <EmptyTab>{t('installed.health.noUpdates')}</EmptyTab>
                        ) : (
                            updatable.map((ins) => {
                                const apiMod = modData.get(ins.id) ?? syntheticMod(ins)
                                return (
                                    <UpdateRow
                                        version={updateVersions.get(ins.id)!}
                                        key={ins.uid}
                                        ins={ins}
                                        apiMod={apiMod}
                                        onOpenDetail={onOpenDetail}
                                    />
                                )
                            })
                        )}
                    </Tabs.Content>
                </ScrollArea>
            </Tabs.Root>

            <div className="flex items-center gap-3 px-5 py-4 border-t border-border shrink-0">
                {activeTab === 'deps' &&
                    missingDeps.some((item) => item.missingDeps?.some((d) => d.id !== null)) && (
                        <>
                            {depInstallError && (
                                <span className="text-xs text-danger-text truncate">
                                    {depInstallError}
                                </span>
                            )}
                            <Button
                                variant="accent"
                                size="md"
                                disabled={!gamePath || installingAll || installingDepId !== null}
                                onClick={() => void installAllDeps()}
                            >
                                {installingAll
                                    ? t('common.installing')
                                    : t('installed.health.installAllDeps')}
                            </Button>
                        </>
                    )}
                {['missing', 'broken', 'outdated'].includes(activeTab) && reinstallFailure && (
                    <span className="text-xs text-danger-text truncate">{reinstallFailure}</span>
                )}
                {activeTab === 'missing' &&
                    missingItems.some((item) => hasCatalogLink(item.mods[0])) && (
                        <Button
                            variant="accent"
                            size="md"
                            disabled={loadingMod !== null || reinstalling}
                            onClick={() =>
                                void reinstallItems(
                                    missingItems.filter((item) => hasCatalogLink(item.mods[0]))
                                )
                            }
                        >
                            {t('installed.health.reinstallAll')}
                        </Button>
                    )}
                {activeTab === 'broken' &&
                    brokenItems.some((item) => hasCatalogLink(item.mods[0])) && (
                        <Button
                            variant="accent"
                            size="md"
                            disabled={loadingMod !== null || reinstalling}
                            onClick={() =>
                                void reinstallItems(
                                    brokenItems.filter((item) => hasCatalogLink(item.mods[0]))
                                )
                            }
                        >
                            {t('installed.health.reinstallAll')}
                        </Button>
                    )}
                {activeTab === 'outdated' && outdatedItems.length > 0 && (
                    <Button
                        variant="accent"
                        size="md"
                        disabled={loadingMod !== null || reinstalling}
                        onClick={() => void reinstallItems(outdatedItems)}
                    >
                        {t('installed.health.reinstallAll')}
                    </Button>
                )}
                {activeTab === 'leftovers' && (
                    <>
                        {leftoverError && (
                            <span className="text-xs text-danger-text truncate">
                                {leftoverError}
                            </span>
                        )}
                        {leftovers.sets.length > 0 && (
                            <Button
                                variant={armedLeftover === 'all' ? 'danger' : 'accent'}
                                size="md"
                                disabled={deletingLeftovers}
                                onClick={() =>
                                    armedLeftover === 'all'
                                        ? void deleteLeftovers(leftovers.sets)
                                        : setArmedLeftover('all')
                                }
                            >
                                {armedLeftover === 'all'
                                    ? t('installed.health.confirmDeleteAll')
                                    : t('installed.health.deleteAllLeftovers')}
                            </Button>
                        )}
                    </>
                )}
                {activeTab === 'updates' && updatable.length > 0 && (
                    <Button variant="accent" size="md" onClick={onReviewUpdates}>
                        {t('installed.reviewUpdates')}
                    </Button>
                )}
                <Button variant="secondary" size="sm" onClick={onClose} className="ml-auto">
                    {t('common.close')}
                </Button>
            </div>
        </Dialog>
    )
}

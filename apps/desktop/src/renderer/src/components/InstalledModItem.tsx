import { useState, useRef, useEffect } from 'react'
import { MoreVertical } from 'lucide-react'
import { t } from '../i18n'
import type { InstalledMod } from '../../../shared/types'
import { ModCard } from './ModCard'
import { ModListRow } from './ModListRow'
import { SkeletonCard } from './SkeletonCard'
import { SkeletonListRow } from './SkeletonListRow'
import { syntheticMod, detailNavArgs, isIdentified } from '../hooks/installedUtils'
import { useInstalledContext } from './InstalledContext'
import { ManageFilesModal } from './ManageFilesModal'
import { hasSource } from '../sources'

export function InstalledModItem({ mods }: { mods: InstalledMod[] }) {
    const {
        viewMode,
        activeGame,
        gamePath,
        modData,
        failedIds,
        loadingMod,
        reinstallProgress,
        dragItem,
        dropTarget,
        onOpenDetail,
        handleUninstall,
        handleEnable,
        handleDisable,
        handleReinstall,
        handleIdentifyViaNexus,
        requestMoveCrimeBossTarget,
        onModPointerDown,
        manageFilesKey,
        setManageFilesKey,
    } = useInstalledContext()

    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!menuOpen) return
        function handleOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', handleOutside)
        return () => document.removeEventListener('mousedown', handleOutside)
    }, [menuOpen])

    const ins = mods[0]
    const id = ins.id
    const repUid = ins.uid
    // Stable across file deletions (repUid is not — the rep file can be the one deleted)
    const groupKey = isIdentified(ins) ? `id:${id}` : `uid:${repUid}`
    const showManageFiles = manageFilesKey === groupKey
    const apiMod = modData.get(id)
    const isBusy = mods.some((m) => loadingMod === m.uid)
    const isDragging = dragItem?.kind === 'mod' && dragItem.uid === repUid
    const combined: InstalledMod = {
        ...ins,
        enabled: mods.some((m) => m.enabled),
        missing: mods.some((m) => m.missing) ? true : undefined,
        archiveBroken: mods.some((m) => m.archiveBroken) ? true : undefined,
    }
    // A Nexus mod always has a real detail source to fetch from (its own REST call,
    // independent of modData), so it can navigate in-app immediately — unlike a
    // modworkshop mod, which has nothing to show until modData actually resolves.
    const handleOpen =
        ins.source === 'nexus' || apiMod !== undefined
            ? () => onOpenDetail(...detailNavArgs(ins))
            : () => {}

    // CB-only: the primary mods/ (ModKit) and legacy ~mods targets are alternate shapes of the
    // same content (see CLAUDE.md's Crime Boss section) — ue4ss_mods and host packs aren't.
    const canMoveCrimeBossTarget =
        activeGame === 'cb' &&
        (combined.location === undefined || combined.location === 'paks') &&
        !combined.missing

    // No point offering this for a mod Modrex can't hash (file missing) or one that
    // already has a real identity — see identify_via_nexus_content_op's own Skipped
    // outcome, which this mirrors so the menu doesn't offer an action that can't do
    // anything. RAID has no Nexus presence at all.
    const canIdentifyViaNexus =
        !isIdentified(ins) && !combined.missing && hasSource(activeGame, 'nexus')

    function renderMenuButton(dropdownSide: 'right' | 'left') {
        return (
            <div ref={menuRef} className="relative">
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen((o) => !o)
                    }}
                    className="flex items-center justify-center w-6 h-6 rounded border border-border text-text-subtle hover:text-text hover:border-accent/60 transition-colors bg-surface-raised/80"
                >
                    <MoreVertical className="w-3.5 h-3.5" />
                </button>
                {menuOpen && (
                    <div
                        className={`absolute top-7 ${dropdownSide === 'right' ? 'right-0' : 'left-0'} min-w-40 bg-surface-raised border border-border rounded-lg shadow-xl overflow-hidden z-50`}
                    >
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                setMenuOpen(false)
                                setManageFilesKey(groupKey)
                            }}
                            className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors"
                        >
                            {t('installed.modMenu.manageFiles')}
                        </button>
                        {canIdentifyViaNexus && (
                            <>
                                <div className="h-px bg-border" />
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpen(false)
                                        void handleIdentifyViaNexus(ins)
                                    }}
                                    disabled={isBusy}
                                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {t('installed.modMenu.identify')}
                                </button>
                            </>
                        )}
                        {canMoveCrimeBossTarget && (
                            <>
                                <div className="h-px bg-border" />
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpen(false)
                                        requestMoveCrimeBossTarget(ins)
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors"
                                >
                                    {combined.location === 'paks'
                                        ? t('installed.crimeBossMove.toModKit')
                                        : t('installed.crimeBossMove.toLegacy')}
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
        )
    }

    // Nexus's own fetch trickles in slowly (rate-limited, one at a time), so a Nexus mod
    // always falls straight to syntheticMod instead of blocking on a skeleton — matching
    // handleOpen's same source split above.
    const isModworkshopSourced = !ins.source || ins.source === 'modworkshop'
    if (!apiMod && !failedIds.has(id) && isModworkshopSourced && isIdentified(ins)) {
        return viewMode === 'list' ? <SkeletonListRow /> : <SkeletonCard />
    }

    const mod = apiMod ?? syntheticMod(ins)

    if (viewMode === 'list') {
        const isBeforeActive = dropTarget?.kind === 'before-mod' && dropTarget.uid === repUid
        const isAfterActive = dropTarget?.kind === 'after-mod' && dropTarget.uid === repUid
        return (
            <div
                className="relative cursor-grab active:cursor-grabbing"
                data-drop-mod={repUid}
                onPointerDown={(e) => onModPointerDown(e, repUid)}
            >
                {isBeforeActive && (
                    <div className="absolute left-0 right-0 top-0 h-0.5 mx-2 rounded-full bg-accent z-10 pointer-events-none" />
                )}
                {isAfterActive && (
                    <div className="absolute left-0 right-0 bottom-0 h-0.5 mx-2 rounded-full bg-accent z-10 pointer-events-none" />
                )}
                {showManageFiles && (
                    <ManageFilesModal
                        mods={mods}
                        modName={mod.name}
                        onClose={() => setManageFilesKey(null)}
                    />
                )}
                <ModListRow
                    mod={mod}
                    installed={combined}
                    gamePath={gamePath}
                    loading={isBusy}
                    progress={isBusy ? reinstallProgress : null}
                    isDragging={isDragging}
                    onOpen={handleOpen}
                    onUninstall={() => handleUninstall(mods)}
                    onEnable={() => handleEnable(mods)}
                    onDisable={() => handleDisable(mods)}
                    onReinstall={() => handleReinstall(mods)}
                    optionsButton={renderMenuButton('left')}
                />
            </div>
        )
    }

    return (
        <div
            data-drop-mod={repUid}
            onPointerDown={(e) => onModPointerDown(e, repUid)}
            className={`relative h-full rounded-lg cursor-grab active:cursor-grabbing transition-opacity ${isDragging ? 'opacity-40' : 'opacity-100'}`}
        >
            {dropTarget?.kind === 'before-mod' && dropTarget.uid === repUid && (
                <div className="absolute top-0 bottom-0 left-0 w-1 bg-accent z-10 pointer-events-none rounded-l-lg" />
            )}
            {dropTarget?.kind === 'after-mod' && dropTarget.uid === repUid && (
                <div className="absolute top-0 bottom-0 right-0 w-1 bg-accent z-10 pointer-events-none rounded-r-lg" />
            )}
            <div ref={menuRef} className="absolute top-2 right-2 z-20">
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen((o) => !o)
                    }}
                    className="flex items-center justify-center w-6 h-6 rounded border border-border text-text-subtle hover:text-text hover:border-accent/60 transition-colors bg-surface-raised/80"
                >
                    <MoreVertical className="w-3.5 h-3.5" />
                </button>
                {menuOpen && (
                    <div className="absolute right-0 top-7 min-w-40 bg-surface-raised border border-border rounded-lg shadow-xl overflow-hidden z-50">
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                setMenuOpen(false)
                                setManageFilesKey(groupKey)
                            }}
                            className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors"
                        >
                            {t('installed.modMenu.manageFiles')}
                        </button>
                        {canIdentifyViaNexus && (
                            <>
                                <div className="h-px bg-border" />
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpen(false)
                                        void handleIdentifyViaNexus(ins)
                                    }}
                                    disabled={isBusy}
                                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {t('installed.modMenu.identify')}
                                </button>
                            </>
                        )}
                        {canMoveCrimeBossTarget && (
                            <>
                                <div className="h-px bg-border" />
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpen(false)
                                        requestMoveCrimeBossTarget(ins)
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-hover transition-colors"
                                >
                                    {combined.location === 'paks'
                                        ? t('installed.crimeBossMove.toModKit')
                                        : t('installed.crimeBossMove.toLegacy')}
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
            {showManageFiles && (
                <ManageFilesModal
                    mods={mods}
                    modName={mod.name}
                    onClose={() => setManageFilesKey(null)}
                />
            )}
            <ModCard
                mod={mod}
                installed={combined}
                gamePath={gamePath}
                loading={isBusy}
                progress={isBusy ? reinstallProgress : null}
                onOpen={handleOpen}
                onInstall={() => {}}
                onUninstall={() => handleUninstall(mods)}
                onEnable={() => handleEnable(mods)}
                onDisable={() => handleDisable(mods)}
                onReinstall={() => handleReinstall(mods)}
            />
        </div>
    )
}

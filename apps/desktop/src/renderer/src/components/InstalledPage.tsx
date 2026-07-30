import { useState, useMemo, useEffect, useRef } from 'react'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { Button } from './ui/Button'
import { SearchClearButton } from './ui/SearchClearButton'
import {
    X,
    Search,
    LayoutGrid,
    List,
    FolderOpen,
    FolderPlus,
    RefreshCw,
    Activity,
} from 'lucide-react'
import { t } from '../i18n'
import { Tooltip } from './Tooltip'
import { ZipPickerModal } from './ZipPickerModal'
import { HostPackModal } from './HostPackModal'
import { UnrecognizedArchiveModal } from './UnrecognizedArchiveModal'
import { CrimeBossFlatArchiveModal } from './CrimeBossFlatArchiveModal'
import { MoveCrimeBossTargetModal } from './MoveCrimeBossTargetModal'
import { UpdatesModal } from './UpdatesModal'
import { HealthCheckModal } from './HealthCheckModal'
import { DeleteFolderModal } from './DeleteFolderModal'
import { FolderSection, NewFolderInput } from './FolderSection'
import { InstalledModItem } from './InstalledModItem'
import { InstalledContext } from './InstalledContext'
import type { InstalledMod, ModFolder, GameId } from '../../../shared/types'
import { GAME_STORAGE_KEY, GAMES } from '../../../shared/types'
import { useModData } from '../hooks/useModData'
import { useDragDrop } from '../hooks/useDragDrop'
import { useFolderActions } from '../hooks/useFolderActions'
import { useModActions } from '../hooks/useModActions'
import { useAutoIdentifyNexusMods } from '../hooks/useAutoIdentifyNexusMods'
import {
    computeChildren,
    groupChildren,
    normalizeModScopes,
    foldersEmptiedByNormalize,
    filterInstalled,
    modworkshopRemoteIds,
    isIdentified,
} from '../hooks/installedUtils'
import { checkMissingDependencies, type HealthItem } from '../hooks/healthCheck'
import { api } from '../api'

type ViewMode = 'grid' | 'list'

function getSavedViewMode(): ViewMode {
    const saved = localStorage.getItem(`modrex:${GAME_STORAGE_KEY}:installed-view`)
    return saved === 'list' ? 'list' : 'grid'
}

interface Props {
    activeGame: GameId
    gamePath: string | null
    installed: InstalledMod[]
    folders: ModFolder[]
    installedReady: boolean
    isActive: boolean
    onRefreshInstalled: () => Promise<void>
    onOpenDetail: (modId: number, source?: 'nexus') => void
}

export function InstalledPage({
    activeGame,
    gamePath,
    installed,
    folders,
    installedReady,
    isActive,
    onRefreshInstalled,
    onOpenDetail,
}: Props) {
    const [viewMode, setViewMode] = useState<ViewMode>(getSavedViewMode)
    const [scanPhase, setScanPhase] = useState<{ phase: string; total: number } | null>(null)
    const { modData, failedIds, updatable } = useModData(
        installed,
        GAMES[activeGame].workshopId,
        activeGame
    )
    const [showUpdates, setShowUpdates] = useState(false)
    const [showHealth, setShowHealth] = useState(false)
    const [checkingHealth, setCheckingHealth] = useState(false)
    const [healthProgress, setHealthProgress] = useState<{ checked: number; total: number } | null>(
        null
    )
    const [healthMissingDeps, setHealthMissingDeps] = useState<HealthItem[]>([])
    const cancelHealthRef = useRef(false)
    const showDepsTab = !!gamePath && modworkshopRemoteIds(installed).length > 0

    useEffect(() => {
        return api.onInstallScan((info) => setScanPhase(info))
    }, [])

    function cancelHealthCheck() {
        cancelHealthRef.current = true
        setCheckingHealth(false)
        setHealthProgress(null)
    }

    // Runs eagerly on click rather than lazily inside the modal — the dependency check costs
    // a network fetch per mod, so the modal only opens once the full report is ready.
    async function runHealthCheck() {
        if (checkingHealth) return
        cancelHealthRef.current = false
        setCheckingHealth(true)
        const positiveIds = modworkshopRemoteIds(installed)
        setHealthProgress(positiveIds.length > 0 ? { checked: 0, total: positiveIds.length } : null)
        try {
            const deps = gamePath
                ? await checkMissingDependencies(
                      installed,
                      positiveIds,
                      gamePath,
                      activeGame,
                      (checked, total) => setHealthProgress({ checked, total })
                  )
                : []
            if (!cancelHealthRef.current) {
                setHealthMissingDeps(deps)
                setShowHealth(true)
            }
        } finally {
            setHealthProgress(null)
            setCheckingHealth(false)
        }
    }
    // Two api.getInstalled calls: onRefreshInstalled updates App state but doesn't
    // return the fresh list, so we fetch once more (local filesystem, ~2ms).
    async function handleDepInstalled() {
        if (!gamePath) return
        await onRefreshInstalled()
        const fresh = await api.getInstalled(activeGame)
        const positiveIds = modworkshopRemoteIds(fresh.mods)
        const deps = await checkMissingDependencies(fresh.mods, positiveIds, gamePath, activeGame)
        setHealthMissingDeps(deps)
    }

    const [filterQuery, setFilterQuery] = useState('')
    // Which group's ManageFilesModal is open. Lives here (not in InstalledModItem)
    // because items remount when their uid-derived keys shift after a deletion.
    const [manageFilesKey, setManageFilesKey] = useState<string | null>(null)

    const {
        loadingMod,
        reinstallProgress,
        reinstallError,
        clearReinstallError,
        refreshing,
        zipPickerData,
        clearZipPickerData,
        hostPackData,
        clearHostPackData,
        unrecognizedModId,
        clearUnrecognizedModId,
        cbFlatArchiveData,
        clearCbFlatArchiveData,
        movingCrimeBossTarget,
        crimeBossMoveBusy,
        crimeBossMoveError,
        identifyNexusResult,
        dismissIdentifyNexusResult,
        handleRefresh,
        handleUninstall,
        handleEnable,
        handleDisable,
        handleReinstall,
        handleIdentifyViaNexus,
        requestMoveCrimeBossTarget,
        confirmMoveCrimeBossTarget,
        cancelMoveCrimeBossTarget,
    } = useModActions(gamePath, onRefreshInstalled, activeGame)

    // Sentinel modals (ZipPicker, HostPack, CbFlatArchive) portal to body but Radix focus traps
    // prevent interacting with them while HealthCheckModal is also open.
    useEffect(() => {
        if (zipPickerData || hostPackData || cbFlatArchiveData) setShowHealth(false)
    }, [zipPickerData, hostPackData, cbFlatArchiveData])

    useAutoIdentifyNexusMods({ installed, gamePath, activeGame, onRefreshInstalled })

    const folderActions = useFolderActions(gamePath, onRefreshInstalled, activeGame)

    const { dragItem, dropTarget, scrollContainerRef, onModPointerDown, onFolderPointerDown } =
        useDragDrop({ installed, folders, gamePath, modData, onRefreshInstalled, activeGame })

    const isFiltering = filterQuery.trim().length > 0
    const { mods: displayMods, visibleFolderIds } = isFiltering
        ? filterInstalled(installed, folders, filterQuery.trim())
        : { mods: installed, visibleFolderIds: undefined }

    const totalUniqueMods = new Set(
        installed.map((m) => (isIdentified(m) ? `id:${m.id}` : `uid:${m.uid}`))
    ).size
    const filteredUniqueMods = new Set(
        displayMods.map((m) => (isIdentified(m) ? `id:${m.id}` : `uid:${m.uid}`))
    ).size

    function setView(mode: ViewMode) {
        setViewMode(mode)
        localStorage.setItem(`modrex:${GAME_STORAGE_KEY}:installed-view`, mode)
    }

    const renderMods = useMemo(() => normalizeModScopes(displayMods), [displayMods])

    const hiddenFolderIds = useMemo(
        () => foldersEmptiedByNormalize(displayMods, renderMods, folders),
        [displayMods, renderMods, folders]
    )

    const rootChildren = useMemo(
        () => computeChildren(renderMods, folders, null, visibleFolderIds, hiddenFolderIds),
        [renderMods, folders, visibleFolderIds, hiddenFolderIds]
    )

    function renderRootMod(mods: InstalledMod[], isFolderDropZone = false) {
        const repUid = mods[0].uid
        const isDropBefore =
            isFolderDropZone &&
            dragItem?.kind === 'folder' &&
            dropTarget?.kind === 'before-child' &&
            dropTarget.id === repUid
        const isDropAfter =
            isFolderDropZone &&
            dragItem?.kind === 'folder' &&
            dropTarget?.kind === 'after-child' &&
            dropTarget.id === repUid

        if (viewMode === 'list') {
            return (
                <div
                    key={repUid}
                    data-drop-child={isFolderDropZone ? repUid : undefined}
                    data-parent-id={isFolderDropZone ? '' : undefined}
                >
                    {isDropBefore && <div className="h-0.5 rounded-full bg-accent mx-2 mb-1" />}
                    <InstalledModItem mods={mods} />
                    {isDropAfter && <div className="h-0.5 rounded-full bg-accent mx-2 mt-1" />}
                </div>
            )
        }
        return (
            <div key={repUid} className="relative">
                <InstalledModItem mods={mods} />
            </div>
        )
    }

    const ctx = {
        modData,
        failedIds,
        viewMode,
        activeGame,
        gamePath,
        isFiltering,
        visibleFolderIds,
        hiddenFolderIds,
        renderMods,
        folders,
        installed,
        onRefreshInstalled,
        onOpenDetail,
        manageFilesKey,
        setManageFilesKey,
        loadingMod,
        reinstallProgress,
        reinstallError,
        clearReinstallError,
        handleUninstall,
        handleEnable,
        handleDisable,
        handleReinstall,
        handleIdentifyViaNexus,
        requestMoveCrimeBossTarget,
        folderActions,
        dragItem,
        dropTarget,
        onModPointerDown,
        onFolderPointerDown,
    }

    return (
        <InstalledContext.Provider value={ctx}>
            <div className="h-full flex flex-col">
                {zipPickerData && gamePath && (
                    <ZipPickerModal
                        payload={zipPickerData}
                        gamePath={gamePath}
                        installedFiles={installed}
                        gameId={activeGame}
                        onRefreshInstalled={onRefreshInstalled}
                        onClose={clearZipPickerData}
                    />
                )}
                {hostPackData && gamePath && (
                    <HostPackModal
                        payload={hostPackData}
                        gamePath={gamePath}
                        installed={installed}
                        gameId={activeGame}
                        onRefreshInstalled={onRefreshInstalled}
                        onClose={clearHostPackData}
                    />
                )}
                {cbFlatArchiveData && gamePath && (
                    <CrimeBossFlatArchiveModal
                        payload={cbFlatArchiveData}
                        gamePath={gamePath}
                        onRefreshInstalled={onRefreshInstalled}
                        onClose={clearCbFlatArchiveData}
                    />
                )}
                {unrecognizedModId !== null && (
                    <UnrecognizedArchiveModal
                        modId={unrecognizedModId}
                        onClose={clearUnrecognizedModId}
                    />
                )}
                {movingCrimeBossTarget && (
                    <MoveCrimeBossTargetModal
                        modName={movingCrimeBossTarget.name}
                        toLegacy={!movingCrimeBossTarget.location}
                        busy={crimeBossMoveBusy}
                        error={crimeBossMoveError}
                        onConfirm={confirmMoveCrimeBossTarget}
                        onCancel={cancelMoveCrimeBossTarget}
                    />
                )}
                <div className="px-6 py-4 border-b border-border shrink-0 flex flex-col gap-3">
                    <div className={`flex items-center justify-between ${TITLE_ROW_MIN_H}`}>
                        <div className="flex items-center gap-2">
                            <h1 className="text-lg font-semibold">{t('installed.title')}</h1>
                            {gamePath && (
                                <Tooltip content={t('installed.openFolder')}>
                                    <button
                                        onClick={() => api.openModsFolder(activeGame)}
                                        className="p-1 rounded bg-surface-hover hover:bg-surface-active text-text-subtle hover:text-text transition-colors"
                                    >
                                        <FolderOpen className="w-3.5 h-3.5" />
                                    </button>
                                </Tooltip>
                            )}
                            <Tooltip content={t('installed.refresh')}>
                                <button
                                    onClick={handleRefresh}
                                    disabled={refreshing}
                                    className="p-1 rounded bg-surface-hover hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-text-subtle hover:text-text transition-colors"
                                >
                                    <RefreshCw
                                        className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                                    />
                                </button>
                            </Tooltip>
                            <Tooltip
                                content={
                                    checkingHealth
                                        ? t('installed.health.cancel')
                                        : t('installed.health.title')
                                }
                            >
                                <button
                                    onClick={
                                        checkingHealth
                                            ? cancelHealthCheck
                                            : () => void runHealthCheck()
                                    }
                                    className="group flex items-center gap-1.5 p-1 rounded transition-colors bg-surface-hover hover:bg-surface-active text-text-subtle hover:text-text cursor-pointer"
                                >
                                    {checkingHealth ? (
                                        <>
                                            <RefreshCw className="group-hover:hidden w-3.5 h-3.5 animate-spin" />
                                            <X className="hidden group-hover:block w-3.5 h-3.5" />
                                            {healthProgress && (
                                                <span className="pr-1 text-[10px] font-medium leading-none tabular-nums">
                                                    {healthProgress.checked}/{healthProgress.total}
                                                </span>
                                            )}
                                        </>
                                    ) : (
                                        <Activity className="w-3.5 h-3.5" />
                                    )}
                                </button>
                            </Tooltip>
                        </div>
                        <div className="flex items-center gap-3">
                            {installed.length > 0 && (
                                <span className="text-xs text-text-subtle">
                                    {isFiltering
                                        ? t('installed.modCountFiltered', {
                                              count: filteredUniqueMods,
                                              total: totalUniqueMods,
                                          })
                                        : t(
                                              totalUniqueMods === 1
                                                  ? 'installed.modCountSingle'
                                                  : 'installed.modCount',
                                              { count: totalUniqueMods }
                                          )}
                                </span>
                            )}
                            {gamePath && (
                                <button
                                    onClick={() => folderActions.startCreateFolder(null)}
                                    className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-surface-hover hover:bg-surface-active text-text-subtle hover:text-text transition-colors"
                                >
                                    <FolderPlus className="w-3.5 h-3.5" />
                                    {t('installed.newFolder')}
                                </button>
                            )}
                            <div className="flex items-center gap-1 bg-surface-hover rounded p-0.5">
                                <Tooltip content={t('installed.gridView')}>
                                    <button
                                        onClick={() => setView('grid')}
                                        className={`p-1 rounded transition-colors ${viewMode === 'grid' ? 'bg-surface-active text-text' : 'text-text-subtle hover:text-text hover:bg-surface-active/50'}`}
                                    >
                                        <LayoutGrid className="w-3.5 h-3.5" />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('installed.listView')}>
                                    <button
                                        onClick={() => setView('list')}
                                        className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'bg-surface-active text-text' : 'text-text-subtle hover:text-text hover:bg-surface-active/50'}`}
                                    >
                                        <List className="w-3.5 h-3.5" />
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                    </div>
                    {installed.length > 0 && (
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                            <input
                                value={filterQuery}
                                onChange={(e) => setFilterQuery(e.target.value)}
                                placeholder={t('installed.filterPlaceholder')}
                                className={`w-full text-sm pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${filterQuery ? 'pr-7' : 'pr-3'}`}
                            />
                            {filterQuery && (
                                <SearchClearButton onClick={() => setFilterQuery('')} />
                            )}
                        </div>
                    )}
                </div>

                {reinstallError && (
                    <div className="px-6 py-2 shrink-0 flex items-center justify-between gap-3 bg-danger/10 border-b border-danger/30 text-danger text-xs">
                        <span className="truncate">
                            {t('installed.reinstallFailed', { error: reinstallError })}
                        </span>
                        <button
                            onClick={clearReinstallError}
                            className="shrink-0 hover:opacity-70 transition-opacity"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
                {identifyNexusResult && (
                    <div
                        className={`px-6 py-2 shrink-0 flex items-center justify-between gap-3 border-b text-xs ${
                            identifyNexusResult.kind === 'error'
                                ? 'bg-danger/10 border-danger/30 text-danger'
                                : 'bg-success/10 border-success/30 text-success-text'
                        }`}
                    >
                        <span className="truncate">{identifyNexusResult.message}</span>
                        <button
                            onClick={dismissIdentifyNexusResult}
                            className="shrink-0 hover:opacity-70 transition-opacity"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
                <div
                    ref={scrollContainerRef}
                    className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3"
                >
                    {!installedReady ? (
                        <div className="flex items-center justify-center h-full text-text-subtle text-sm">
                            {scanPhase?.phase === 'hashing'
                                ? t('installed.identifyingNew', { count: scanPhase.total })
                                : t('common.loading')}
                        </div>
                    ) : installed.length === 0 && folders.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-text-subtle text-sm">
                            {t('installed.empty')}
                        </div>
                    ) : isFiltering && displayMods.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-text-subtle text-sm">
                            {t('installed.filterEmpty', { query: filterQuery.trim() })}
                        </div>
                    ) : (
                        <>
                            {updatable.length > 0 && (
                                <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-accent/10 border border-accent/30">
                                    <span className="text-sm font-medium text-accent">
                                        {t(
                                            updatable.length === 1
                                                ? 'installed.updatesAvailableSingle'
                                                : 'installed.updatesAvailable',
                                            { count: updatable.length }
                                        )}
                                    </span>
                                    <Button
                                        variant="accent"
                                        size="sm"
                                        onClick={() => setShowUpdates(true)}
                                    >
                                        {t('installed.reviewUpdates')}
                                    </Button>
                                </div>
                            )}

                            {folderActions.creatingFolderParentId === null && <NewFolderInput />}

                            {viewMode === 'list' ? (
                                <div className="flex flex-col gap-1.5">
                                    {rootChildren.map((item) =>
                                        item.type === 'folder' ? (
                                            <FolderSection
                                                key={item.folder.id}
                                                folder={item.folder}
                                            />
                                        ) : (
                                            renderRootMod(item.mods)
                                        )
                                    )}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-3">
                                    {groupChildren(rootChildren).map((group) => {
                                        if (group.type === 'folder') {
                                            return (
                                                <FolderSection
                                                    key={group.folder.id}
                                                    folder={group.folder}
                                                />
                                            )
                                        }
                                        const leaderId = group.groups[0][0].uid
                                        const isGroupDropBefore =
                                            dragItem?.kind === 'folder' &&
                                            dropTarget?.kind === 'before-child' &&
                                            dropTarget.id === leaderId
                                        const isGroupDropAfter =
                                            dragItem?.kind === 'folder' &&
                                            dropTarget?.kind === 'after-child' &&
                                            dropTarget.id === leaderId
                                        return (
                                            <div
                                                key={`rg-${leaderId}`}
                                                className="relative grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4"
                                                data-drop-child={leaderId}
                                                data-parent-id=""
                                            >
                                                {isGroupDropBefore && (
                                                    <div className="absolute -top-1 left-0 right-0 h-0.5 rounded-full bg-accent pointer-events-none" />
                                                )}
                                                {isGroupDropAfter && (
                                                    <div className="absolute -bottom-1 left-0 right-0 h-0.5 rounded-full bg-accent pointer-events-none" />
                                                )}
                                                {group.groups.map((mods) => renderRootMod(mods))}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {showUpdates && (
                    <UpdatesModal
                        updatable={updatable}
                        modData={modData}
                        installed={installed}
                        gamePath={gamePath}
                        gameId={activeGame}
                        visible={isActive}
                        onRefreshInstalled={onRefreshInstalled}
                        onClose={() => setShowUpdates(false)}
                        onOpenDetail={onOpenDetail}
                    />
                )}

                {showHealth && (
                    <HealthCheckModal
                        installed={installed}
                        updatable={updatable}
                        modData={modData}
                        missingDeps={healthMissingDeps}
                        showDepsTab={showDepsTab}
                        gamePath={gamePath}
                        gameId={activeGame}
                        loadingMod={loadingMod}
                        visible={isActive}
                        onOpenDetail={onOpenDetail}
                        onReinstall={handleReinstall}
                        onDepInstalled={handleDepInstalled}
                        onReviewUpdates={() => {
                            setShowHealth(false)
                            setShowUpdates(true)
                        }}
                        onClose={() => setShowHealth(false)}
                    />
                )}

                {folderActions.deletingFolderId !== null && (
                    <DeleteFolderModal
                        onConfirm={folderActions.confirmDeleteFolder}
                        onCancel={folderActions.cancelDelete}
                    />
                )}
            </div>
        </InstalledContext.Provider>
    )
}

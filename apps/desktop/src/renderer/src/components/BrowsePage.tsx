import { ScrollArea } from './ScrollArea'
import { useState, useEffect, useCallback, useRef, useMemo, memo, startTransition } from 'react'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { Search, LayoutGrid, ArrowDownUp, X, CloudOff, SearchX } from 'lucide-react'
import type {
    Mod,
    ModFile,
    Paginated,
    InstalledMod,
    Category,
    ModTag,
    ModDependency,
    SortOption,
    GameId,
    ModSummary,
} from '../../../shared/types'
import { GAMES } from '../../../shared/types'
import { getCachedMod, getCachedModFiles, getCachedModLinks } from '../modCache'
import {
    getBrowseCache,
    setBrowseCache,
    getCategoriesCache,
    setCategoriesCache,
    getTagsCache,
    setTagsCache,
} from '../browseCache'
import { SearchClearButton } from './ui/SearchClearButton'
import { EmptyState } from './ui/EmptyState'
import { ModCard } from './ModCard'
import { SkeletonCard } from './SkeletonCard'
import { Select } from './Select'
import { TagFilter } from './TagFilter'
import { SourceSelect } from './SourceSelect'
import { DepsWarningModal } from './DepsWarningModal'
import { FileSelectModal } from './FileSelectModal'
import { NonPakConfirmModal } from './NonPakConfirmModal'
import { CrimeBossInstallTargetModal } from './CrimeBossInstallTargetModal'
import { useCrimeBossInstallTarget } from '../hooks/useCrimeBossInstallTarget'
import { isUnsupportedFormat } from '../formatCheck'
import { missingRequiredDeps } from '../deps'
import { loaderForModId, loadersForGame } from '../loaders'
import { useLoaderState } from '../hooks/useLoaderState'
import { resolveDepCheck } from '../installDepCheck'
import { t } from '../i18n'
import { api } from '../api'
import { requestInstallChoice } from '../installChoices'
import {
    useInstallOperations,
    getModInstall,
    isInstallBusy,
    installProgress,
    installLabel,
    type InstallOperation,
} from '../installState'
import { runBulkAction } from '../bulkAction'
import { trackSearch } from '../lib/analytics/events'
import { markForegroundActivity, waitForForegroundClear } from '../requestPriority'

interface Props {
    activeGame: GameId
    workshopId: number
    isActive: boolean
    gamePath: string | null
    gamePathReady: boolean
    installed: InstalledMod[]
    onRefreshInstalled: () => Promise<void>
    source: string
    onSourceChange: (next: string) => void
    onOpenDetail: (modId: number, initialMod?: ModSummary) => void
    onGoToSettings?: () => void
}

function buildPages(current: number, last: number): (number | '...')[] {
    const pages: (number | '...')[] = []
    const delta = 2
    const left = current - delta
    const right = current + delta

    let prev: number | null = null
    for (let p = 1; p <= last; p++) {
        if (p === 1 || p === last || (p >= left && p <= right)) {
            if (prev !== null && p - prev > 1) pages.push('...')
            pages.push(p)
            prev = p
        }
    }
    return pages
}

// api.rs's api_get formats a rate-limit failure as "modworkshop API 429: <path>"
// after exhausting its own retries. Matches "API 429" specifically (not just
// "429") so a 429 appearing inside a path segment in some other error doesn't
// false-positive.
function isRateLimitError(error: string): boolean {
    return error.includes('API 429')
}

const SORT_VALUES: SortOption[] = ['bumped_at', 'downloads', 'likes', 'published_at', 'name']

// Memo boundary for the card grid. The grid is the expensive part of BrowsePage
// (24 cards, each with tooltips, toggles and images), so it must only re-render when its data
// actually changes, not on isActive flips, search keystrokes, or modal and error
// state. All handler props must stay useCallback-stable in BrowsePage or the
// boundary is defeated. GridCard keeps the per-card closures inside its own memo
// so a grid re-render (e.g. download progress) only re-renders the affected card.
interface CardHandlers {
    onOpen: (modId: number, initialMod?: ModSummary) => void
    onPrefetch: (modId: number) => void
    onInstall: (modId: number) => void
    onUninstall: (modId: number) => void
    onEnable: (modId: number) => void
    onDisable: (modId: number) => void
}

interface GridCardProps extends CardHandlers {
    mod: ModSummary
    installed: InstalledMod | undefined
    gamePath: string | null
    loading: boolean
    progress: { downloaded: number; total: number } | null
    loadingLabel?: string
    loaderInstalled?: boolean
}

const GridCard = memo(function GridCard(p: GridCardProps) {
    return (
        <ModCard
            mod={p.mod}
            installed={p.installed}
            loaderInstalled={p.loaderInstalled}
            gamePath={p.gamePath}
            loading={p.loading}
            progress={p.progress}
            loadingLabel={p.loadingLabel}
            showMeta
            onOpen={() => p.onOpen(p.mod.id, p.mod)}
            onPrefetch={() => p.onPrefetch(p.mod.id)}
            onInstall={() => p.onInstall(p.mod.id)}
            onUninstall={() => p.onUninstall(p.mod.id)}
            onEnable={() => p.onEnable(p.mod.id)}
            onDisable={() => p.onDisable(p.mod.id)}
        />
    )
})

interface ModGridProps extends CardHandlers {
    gridLoading: boolean
    result: Paginated<ModSummary> | null
    installedByModId: Map<number, InstalledMod[]>
    gamePath: string | null
    installingMods: ReadonlySet<number>
    operations: readonly InstallOperation[]
    loaderInstalledIds: Set<number>
}

const ModGrid = memo(function ModGrid({
    gridLoading,
    result,
    installedByModId,
    gamePath,
    installingMods,
    operations,
    loaderInstalledIds,
    ...handlers
}: ModGridProps) {
    if (gridLoading) {
        return (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                {Array.from({ length: 24 }, (_, i) => (
                    <SkeletonCard key={i} />
                ))}
            </div>
        )
    }
    if (!result) {
        // Cold start with nothing cached and the fetch failed. Without this,
        // loadingMods=false + result=null fell through to the skeleton branch
        // above and rendered placeholder cards forever.
        return <EmptyState icon={CloudOff}>{t('browse.loadFailed')}</EmptyState>
    }
    if (result.data.length === 0) {
        return <EmptyState icon={SearchX}>{t('browse.noMods')}</EmptyState>
    }
    return (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
            {result.data.map((mod) => {
                const operation = getModInstall(operations, 'modworkshop', mod.id)
                return (
                    <GridCard
                        key={mod.id}
                        mod={mod}
                        installed={installedByModId.get(mod.id)?.[0]}
                        loaderInstalled={loaderInstalledIds.has(mod.id) ? true : undefined}
                        gamePath={gamePath}
                        loading={installingMods.has(mod.id) || isInstallBusy(operation)}
                        progress={installProgress(operation)}
                        loadingLabel={
                            isInstallBusy(operation) ? installLabel(operation) : undefined
                        }
                        {...handlers}
                    />
                )
            })}
        </div>
    )
})

function getSavedSort(game: GameId): SortOption {
    const saved = localStorage.getItem(`modrex:${GAMES[game].storageKey}:browse-sort`)
    return SORT_VALUES.includes(saved as SortOption) ? (saved as SortOption) : 'bumped_at'
}

export function BrowsePage({
    activeGame,
    workshopId,
    isActive,
    source,
    onSourceChange,
    gamePath,
    gamePathReady,
    installed,
    onRefreshInstalled,
    onOpenDetail,
    onGoToSettings,
}: Props) {
    const [page, setPage] = useState(1)
    const [query, setQuery] = useState('')
    const [categoryId, setCategoryId] = useState<number | undefined>()
    const [includeTags, setIncludeTags] = useState<number[]>([])
    const [excludeTags, setExcludeTags] = useState<number[]>([])
    const initialSort = getSavedSort(activeGame)
    const [sort, setSort] = useState<SortOption>(initialSort)
    const initialCache = getBrowseCache(workshopId, 1, '', initialSort, undefined)
    const [result, setResult] = useState<Paginated<ModSummary> | null>(initialCache?.result ?? null)
    const [categories, setCategories] = useState<Category[]>(
        () => getCategoriesCache(workshopId) ?? []
    )
    const [tags, setTags] = useState<ModTag[]>(() => getTagsCache(workshopId) ?? [])
    const [loadingMods, setLoadingMods] = useState(!initialCache)
    const [installingMods, setInstallingMods] = useState<ReadonlySet<number>>(new Set())
    const operations = useInstallOperations(activeGame)
    const [error, setError] = useState<string | null>(null)
    const [categoryError, setCategoryError] = useState<string | null>(null)
    const [tagError, setTagError] = useState<string | null>(null)
    // Enable, disable and uninstall report separately from a failed listing fetch: the grid
    // stays usable, so hiding it behind the fetch error would be wrong.
    const [actionError, setActionError] = useState<string | null>(null)
    const [depsWarning, setDepsWarning] = useState<{
        modId: number
        allDeps: ModDependency[]
        bltLoaderInstalled: boolean | null
    } | null>(null)
    const [fileSelect, setFileSelect] = useState<{ mod: Mod; files: ModFile[] } | null>(null)
    const [formatWarning, setFormatWarning] = useState<{ modId: number; mod: ModSummary } | null>(
        null
    )
    const sortOptions: { value: SortOption; label: string }[] = useMemo(
        () => [
            { value: 'bumped_at', label: t('browse.sort.lastUpdated') },
            { value: 'downloads', label: t('browse.sort.mostDownloaded') },
            { value: 'likes', label: t('browse.sort.mostLiked') },
            { value: 'published_at', label: t('browse.sort.newest') },
            { value: 'name', label: t('browse.sort.name') },
        ],
        []
    )
    const crimeBossInstallTarget = useCrimeBossInstallTarget(
        activeGame,
        gamePath,
        onRefreshInstalled
    )
    const { runInstall: runCrimeBossInstall } = crimeBossInstallTarget
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const fetchIdRef = useRef(0)
    const [lastMeta, setLastMeta] = useState<{ last_page: number; total: number } | null>(null)
    const {
        loaderState,
        setLoaderFlag,
        refreshLoader,
        installLoader,
        loaderModIds,
        ue4ssPageId,
        refreshUe4ssPage,
    } = useLoaderState(activeGame, gamePath)

    // Re-runs on browse re-activation, not just gamePath, so a loader installed from a mod's
    // detail page (which updates only that page's own presence state) is reflected on the
    // browse cards when the user returns. Loaders aren't tracked in the installed list, so
    // there's no installed-array change to key off; the DLL/file presence check is cheap.
    useEffect(() => {
        if (!gamePath || !isActive) return
        let cancelled = false
        // SuperBLT is excluded: it has no mod page, so no browse card can show its state.
        for (const loader of loadersForGame(activeGame)) {
            if (loader.modworkshopIds.length === 0) continue
            api.checkLoader(loader.id, activeGame, gamePath).then((v) => {
                if (!cancelled) setLoaderFlag(loader.id, v)
            })
        }
        void refreshUe4ssPage()
        return () => {
            cancelled = true
        }
    }, [gamePath, isActive]) // eslint-disable-line react-hooks/exhaustive-deps -- activeGame is stable per mount; BrowsePage remounts on game change via key={activeGame}

    const fetchMods = useCallback(
        async (
            p: number,
            q: string,
            cat: number | undefined,
            s: SortOption,
            inc: number[],
            exc: number[]
        ) => {
            const id = ++fetchIdRef.current
            const cached = getBrowseCache(workshopId, p, q, s, cat, inc, exc)
            if (cached) {
                setResult(cached.result)
                setLoadingMods(false)
                if (!cached.stale) return
            }
            setError(null)
            markForegroundActivity()
            try {
                const data = await api.listMods(workshopId, {
                    page: p,
                    limit: 24,
                    sort: s,
                    query: q || undefined,
                    category_id: cat,
                    tags: inc.length ? inc : undefined,
                    block_tags: exc.length ? exc : undefined,
                })
                if (fetchIdRef.current !== id) return
                setBrowseCache(workshopId, p, q, s, cat, data, inc, exc)
                if (q) trackSearch(activeGame, q.length, data.meta.total)
                startTransition(() => {
                    setResult(data)
                    setLoadingMods(false)
                })
            } catch (e) {
                if (fetchIdRef.current !== id) return
                setError(String(e))
                setLoadingMods(false)
            } finally {
                markForegroundActivity()
            }
        },
        [workshopId, activeGame] // both stable per mount, BrowsePage remounts via key={activeGame}
    )

    useEffect(() => {
        const cached = getCategoriesCache(workshopId)
        if (cached) {
            setCategoryError(null)
            setCategories(cached)
            return
        }
        setCategoryError(null)
        api.listCategories(workshopId)
            .then((r) => {
                setCategoriesCache(workshopId, r.data)
                setCategories(r.data)
            })
            .catch((e) => setCategoryError(String(e)))
    }, [workshopId]) // stable per mount, BrowsePage remounts via key={activeGame}

    useEffect(() => {
        const cached = getTagsCache(workshopId)
        if (cached) {
            setTagError(null)
            setTags(cached)
            return
        }
        setTagError(null)
        api.listTags(workshopId)
            .then((r) => {
                setTagsCache(workshopId, r.data)
                setTags(r.data)
            })
            .catch((e) => setTagError(String(e)))
    }, [workshopId]) // stable per mount, BrowsePage remounts via key={activeGame}

    // Fetches only while the page is visible. Re-runs on activation (isActive
    // false to true) so stale cache entries get a background refresh, while fresh ones
    // early-return inside fetchMods. Scroll resets only on a filter change, not
    // on activation, so the position survives tab switches.
    //
    // When filter params change, the stale result is cleared immediately so the
    // skeleton grid shows at once instead of old content hanging around for the
    // debounce window. On isActive re-entry with unchanged params we deliberately
    // keep showing the cached result during the background refresh (SWR behaviour).
    const lastFiltersRef = useRef('')
    useEffect(() => {
        if (result) setLastMeta({ last_page: result.meta.last_page, total: result.meta.total })
    }, [result])
    useEffect(() => {
        if (!isActive) return
        const filters = JSON.stringify([page, query, categoryId, sort, includeTags, excludeTags])
        const filtersChanged = filters !== lastFiltersRef.current
        if (filtersChanged) {
            lastFiltersRef.current = filters
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            setResult(null)
            setLoadingMods(true)
        }
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(
            () => {
                fetchMods(page, query, categoryId, sort, includeTags, excludeTags)
            },
            query ? 400 : 0
        )
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current)
        }
    }, [isActive, fetchMods, page, query, categoryId, sort, includeTags, excludeTags])

    function handleQueryChange(val: string) {
        setQuery(val)
        setPage(1)
    }

    function handleCategoryChange(val: string) {
        setCategoryId(val ? Number(val) : undefined)
        setPage(1)
    }

    function handleTagsChange(inc: number[], exc: number[]) {
        setIncludeTags(inc)
        setExcludeTags(exc)
        setPage(1)
    }

    function handleSortChange(val: string) {
        localStorage.setItem(`modrex:${GAMES[activeGame].storageKey}:browse-sort`, val)
        setSort(val as SortOption)
        setPage(1)
    }

    const handlePrefetch = useCallback((modId: number) => {
        if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
        prefetchTimerRef.current = setTimeout(() => {
            waitForForegroundClear().then(() => {
                getCachedMod(modId).catch(() => {})
                getCachedModFiles(modId).catch(() => {})
                getCachedModLinks(modId).catch(() => {})
            })
        }, 150)
    }, [])

    const addInstalling = useCallback((id: number) => {
        setInstallingMods((prev) => {
            const s = new Set(prev)
            s.add(id)
            return s
        })
    }, [])

    const removeInstalling = useCallback((id: number) => {
        setInstallingMods((prev) => {
            const s = new Set(prev)
            s.delete(id)
            return s
        })
    }, [])

    const doInstall = useCallback(
        async (modId: number) => {
            if (!gamePath) return
            const loader = loaderForModId(activeGame, modId)
            if (loader && !loader.viaModFlow) {
                await api.installLoader(loader.id, gamePath)
                await refreshLoader(loader.id)
            } else {
                const outcome = await api.installMod(modId, gamePath, activeGame)
                await requestInstallChoice(outcome, activeGame, gamePath, installed, null, modId)
                if (typeof outcome === 'object' && 'needsLoaderConfirm' in outcome) {
                    await refreshUe4ssPage()
                    await refreshLoader('ue4ss')
                }
                // A viaModFlow loader is not tracked in the installed list; its install is
                // routed server-side via the UE4SS_LOADER sentinel, so re-read presence to
                // learn whether it actually landed.
                if (loader) await refreshLoader(loader.id)
            }
            await onRefreshInstalled()
        },
        [gamePath, activeGame, installed, onRefreshInstalled, refreshLoader, refreshUe4ssPage]
    )

    const handleInstall = useCallback(
        async (modId: number) => {
            if (!gamePath) return
            setError(null)
            addInstalling(modId)
            try {
                const fullMod = await getCachedMod(modId)
                if (fullMod.disable_mod_managers) {
                    setError(t('common.modManagerDisabled'))
                    return
                }
                if (fullMod.download?.url && !fullMod.download.download_url) {
                    api.openExternal(fullMod.download.url)
                    return
                }
                // Dep check runs here, before FileSelectModal, because multi-file mods
                // go through FileSelectModal which has no dep check of its own.
                const depResult = await resolveDepCheck(
                    modId,
                    fullMod,
                    gamePath,
                    activeGame,
                    installed,
                    loaderState
                )
                if (depResult) {
                    removeInstalling(modId)
                    setDepsWarning({
                        modId,
                        allDeps: depResult.allDeps,
                        bltLoaderInstalled: depResult.bltLoaderInstalled,
                    })
                    return
                }
                let checkType: string | null | undefined
                let checkUrl: string | null | undefined
                let checkFilename: string | undefined
                if (fullMod.download === null) {
                    const files = await getCachedModFiles(modId)
                    if (files.length > 1) {
                        removeInstalling(modId)
                        setFileSelect({ mod: fullMod, files })
                        return
                    }
                    checkType = files[0]?.type
                    checkUrl = files[0]?.download_url
                    checkFilename = files[0]?.name
                } else {
                    checkType = fullMod.download.type
                    checkUrl = fullMod.download.download_url
                }
                if (isUnsupportedFormat(GAMES[activeGame], checkType, checkUrl, checkFilename)) {
                    removeInstalling(modId)
                    setFormatWarning({ modId, mod: fullMod })
                    return
                }
                await runCrimeBossInstall(modId, fullMod.name, () => doInstall(modId))
            } catch (e) {
                setError(String(e))
            } finally {
                removeInstalling(modId)
            }
        },
        [
            gamePath,
            activeGame,
            installed,
            loaderState,
            doInstall,
            runCrimeBossInstall,
            addInstalling,
            removeInstalling,
        ]
    )

    const handleUninstall = useCallback(
        async (modId: number) => {
            if (!gamePath) return
            // modId here is always a real modworkshop id (Browse is modworkshop-only);
            // InstalledMod.id is an opaque local key, so match against remoteId instead.
            const modIdStr = String(modId)
            const uids = installed
                .filter((m) => (!m.source || m.source === 'modworkshop') && m.remoteId === modIdStr)
                .map((m) => m.uid)
            if (uids.length === 0) return
            addInstalling(modId)
            try {
                for (const uid of uids) await api.uninstallMod(uid, gamePath, activeGame)
                await onRefreshInstalled()
            } finally {
                removeInstalling(modId)
            }
        },
        [gamePath, installed, activeGame, onRefreshInstalled, addInstalling, removeInstalling]
    )

    const handleEnable = useCallback(
        async (modId: number) => {
            if (!gamePath) return
            // modId here is always a real modworkshop id (Browse is modworkshop-only);
            // InstalledMod.id is an opaque local key, so match against remoteId instead.
            const modIdStr = String(modId)
            const uids = installed
                .filter((m) => (!m.source || m.source === 'modworkshop') && m.remoteId === modIdStr)
                .map((m) => m.uid)
            if (uids.length === 0) return
            addInstalling(modId)
            try {
                setActionError(
                    await runBulkAction(
                        uids,
                        (uid) => installed.find((m) => m.uid === uid)?.name ?? '',
                        (uid) => api.enableMod(uid, gamePath, activeGame),
                        onRefreshInstalled
                    )
                )
            } finally {
                removeInstalling(modId)
            }
        },
        [gamePath, installed, activeGame, onRefreshInstalled, addInstalling, removeInstalling]
    )

    const handleDisable = useCallback(
        async (modId: number) => {
            if (!gamePath) return
            // modId here is always a real modworkshop id (Browse is modworkshop-only);
            // InstalledMod.id is an opaque local key, so match against remoteId instead.
            const modIdStr = String(modId)
            const uids = installed
                .filter((m) => (!m.source || m.source === 'modworkshop') && m.remoteId === modIdStr)
                .map((m) => m.uid)
            if (uids.length === 0) return
            addInstalling(modId)
            try {
                setActionError(
                    await runBulkAction(
                        uids,
                        (uid) => installed.find((m) => m.uid === uid)?.name ?? '',
                        (uid) => api.disableMod(uid, gamePath, activeGame),
                        onRefreshInstalled
                    )
                )
            } finally {
                removeInstalling(modId)
            }
        },
        [gamePath, installed, activeGame, onRefreshInstalled, addInstalling, removeInstalling]
    )

    const installedByModId = useMemo(() => {
        const map = new Map<number, InstalledMod[]>()
        for (const m of installed) {
            // Keyed by real modworkshop id (what ModCard/handlers look this up by), not
            // InstalledMod.id, an opaque local key that never means "modworkshop id".
            // Source-gated too: a Nexus mod's remoteId is a real Nexus id, which can
            // coincidentally equal some unrelated modworkshop mod's id.
            if (m.source && m.source !== 'modworkshop') continue
            const remoteId = Number(m.remoteId)
            if (!Number.isFinite(remoteId) || remoteId <= 0) continue
            const list = map.get(remoteId)
            if (list) list.push(m)
            else map.set(remoteId, [m])
        }
        return map
    }, [installed])

    const missingDepsList = depsWarning
        ? missingRequiredDeps(
              depsWarning.allDeps,
              installed,
              depsWarning.bltLoaderInstalled,
              loaderModIds
          )
        : []
    const filterError = categoryError ?? tagError
    const visibleError = error ?? filterError
    const visibleErrorMessage =
        error ?? (filterError ? t('browse.filterLoadFailed', { error: filterError }) : null)

    return (
        <div className="h-full flex flex-col">
            {formatWarning && (
                <NonPakConfirmModal
                    onConfirm={async () => {
                        const { modId, mod: fullMod } = formatWarning
                        setFormatWarning(null)
                        addInstalling(modId)
                        try {
                            await runCrimeBossInstall(modId, fullMod.name, () => doInstall(modId))
                        } catch (e) {
                            setError(String(e))
                        } finally {
                            removeInstalling(modId)
                        }
                    }}
                    onCancel={() => setFormatWarning(null)}
                />
            )}
            {fileSelect && (
                <FileSelectModal
                    mod={fileSelect.mod}
                    files={fileSelect.files}
                    gamePath={gamePath}
                    installedFiles={installed.filter(
                        (m) =>
                            (!m.source || m.source === 'modworkshop') &&
                            m.remoteId === String(fileSelect.mod.id)
                    )}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setFileSelect(null)}
                />
            )}
            {crimeBossInstallTarget.pendingChoice && (
                <CrimeBossInstallTargetModal
                    modName={crimeBossInstallTarget.pendingChoice.modName}
                    busy={crimeBossInstallTarget.relocating}
                    error={crimeBossInstallTarget.error}
                    onChoose={crimeBossInstallTarget.confirmChoice}
                    onCancel={crimeBossInstallTarget.cancelChoice}
                />
            )}
            {depsWarning && (
                <DepsWarningModal
                    modId={depsWarning.modId}
                    missingRequired={missingDepsList}
                    gamePath={gamePath}
                    gameId={activeGame}
                    loaderModIds={loadersForGame(activeGame).flatMap((l) => l.modworkshopIds)}
                    onInstallLoader={async (loaderModId) => {
                        try {
                            const ok = await installLoader(loaderModId)
                            // The offsite BLT dep has no mod page, so the warning modal
                            // reads its state from bltLoaderInstalled rather than by id.
                            if (loaderModId === null) {
                                setDepsWarning((w) => (w ? { ...w, bltLoaderInstalled: ok } : w))
                            }
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setDepsWarning(null)}
                    onGotIt={async (permanent) => {
                        sessionStorage.setItem(`depsWarningDismissed-${depsWarning.modId}`, '1')
                        if (permanent) await api.dismissDepsWarning(depsWarning.modId)
                        setDepsWarning(null)
                    }}
                    onOpenDetail={(modId) => {
                        setDepsWarning(null)
                        onOpenDetail(modId)
                    }}
                />
            )}
            <div className="px-6 py-4 border-b border-border shrink-0 flex flex-col gap-3">
                <div className={`flex items-center justify-between gap-3 ${TITLE_ROW_MIN_H}`}>
                    <div className="flex items-center gap-3 min-w-0">
                        <h1 className="text-lg font-semibold shrink-0">{t('browse.title')}</h1>
                        <SourceSelect
                            activeGame={activeGame}
                            value={source}
                            onChange={onSourceChange}
                        />
                    </div>
                    {gamePathReady && !gamePath && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-warning bg-warning/10 px-3 py-1 rounded">
                                {t('browse.gameNotFound')}
                            </span>
                            {onGoToSettings && (
                                <button
                                    onClick={onGoToSettings}
                                    className="text-xs text-accent hover:text-accent-bright underline transition-colors"
                                >
                                    {t('browse.goToSettings')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                        <input
                            type="text"
                            placeholder={t('browse.searchPlaceholder')}
                            value={query}
                            onChange={(e) => handleQueryChange(e.target.value)}
                            className={`w-full text-sm pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${query ? 'pr-7' : 'pr-3'}`}
                        />
                        {query && <SearchClearButton onClick={() => handleQueryChange('')} />}
                    </div>
                    <Select
                        value={categoryId?.toString() ?? ''}
                        onChange={handleCategoryChange}
                        placeholder={t('browse.allCategories')}
                        icon={<LayoutGrid className="w-3.5 h-3.5 text-text-subtle" />}
                        options={[
                            { value: '', label: t('browse.allCategories') },
                            ...categories.map((c) => ({ value: String(c.id), label: c.name })),
                        ]}
                    />
                    {tags.length > 0 && (
                        <TagFilter
                            tags={tags}
                            include={includeTags}
                            exclude={excludeTags}
                            onChange={handleTagsChange}
                        />
                    )}
                    <Select
                        value={sort}
                        onChange={handleSortChange}
                        icon={<ArrowDownUp className="w-3.5 h-3.5 text-text-subtle" />}
                        options={sortOptions.map((o) => ({ value: o.value, label: o.label }))}
                    />
                </div>
            </div>

            {actionError && (
                <div className="mx-6 mt-4 px-4 py-3 bg-danger/30 border border-danger-hover rounded text-sm text-danger-text flex items-center justify-between gap-3">
                    <span className="truncate">{actionError}</span>
                    <button
                        onClick={() => setActionError(null)}
                        className="shrink-0 hover:opacity-70 transition-opacity"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            {visibleError &&
                (isRateLimitError(visibleError) ? (
                    <div className="mx-6 mt-4 px-4 py-3 bg-warning/10 border border-warning/30 rounded text-sm text-warning">
                        {t('browse.rateLimited')}
                    </div>
                ) : (
                    <div className="mx-6 mt-4 px-4 py-3 bg-danger/30 border border-danger-hover rounded text-sm text-danger-text">
                        {visibleErrorMessage}
                    </div>
                ))}

            <ScrollArea
                hostClassName="flex-1"
                ref={scrollRef}
                className="overflow-y-auto px-6 py-4"
            >
                <ModGrid
                    gridLoading={loadingMods}
                    result={result}
                    installedByModId={installedByModId}
                    gamePath={gamePath}
                    installingMods={installingMods}
                    operations={operations}
                    loaderInstalledIds={
                        new Set(
                            loadersForGame(activeGame)
                                .filter((l) => loaderState[l.id])
                                .flatMap((l) =>
                                    // UE4SS ships from several pages, so only the one the
                                    // installed files came from is marked. Every other loader
                                    // has a single page, which its presence flag settles.
                                    l.id === 'ue4ss'
                                        ? ue4ssPageId === null
                                            ? []
                                            : [ue4ssPageId]
                                        : l.modworkshopIds
                                )
                        )
                    }
                    onOpen={onOpenDetail}
                    onPrefetch={handlePrefetch}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                    onEnable={handleEnable}
                    onDisable={handleDisable}
                />
            </ScrollArea>

            {(() => {
                const footerMeta = result?.meta ?? lastMeta
                if (!footerMeta || footerMeta.last_page <= 1) return null
                return (
                    <div className="px-6 py-3 border-t border-border flex items-center justify-between shrink-0">
                        <span className="text-xs text-text-subtle">
                            {footerMeta.total > 0 &&
                                t('browse.modCount', { total: footerMeta.total })}
                        </span>
                        <div className="flex gap-1">
                            {buildPages(page, footerMeta.last_page).map((p, i) =>
                                p === '...' ? (
                                    <span
                                        key={`ellipsis-${i}`}
                                        className="text-xs px-2 py-1 text-text-subtle"
                                    >
                                        …
                                    </span>
                                ) : (
                                    <button
                                        key={p}
                                        onClick={() => setPage(p as number)}
                                        className={`text-xs px-3 py-1 rounded transition-colors ${
                                            p === page
                                                ? 'bg-accent-fill text-white'
                                                : 'bg-surface-hover hover:bg-surface-active'
                                        }`}
                                    >
                                        {p}
                                    </button>
                                )
                            )}
                        </div>
                    </div>
                )
            })()}
        </div>
    )
}

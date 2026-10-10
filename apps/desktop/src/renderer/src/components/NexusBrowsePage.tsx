import { ScrollArea } from './ScrollArea'
import { useState, useEffect, useMemo, useRef } from 'react'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { nativeIdFor } from '../sources'
import { Search, ArrowDownUp } from 'lucide-react'
import type { GameId, InstalledMod, ModSummary, Paginated } from '../../../shared/types'
import { GAMES } from '../../../shared/types'
import { SearchClearButton } from './ui/SearchClearButton'
import { SkeletonCard } from './SkeletonCard'
import { ModCard } from './ModCard'
import { Select } from './Select'
import { SourceSelect } from './SourceSelect'
import { t } from '../i18n'
import { api } from '../api'

interface Props {
    activeGame: GameId
    isActive: boolean
    source: string
    onSourceChange: (next: string) => void
    gamePath: string | null
    installed: InstalledMod[]
    onRefreshInstalled: () => Promise<void>
    onGoToSettings: () => void
    onOpenDetail: (modId: number, initialMod?: ModSummary) => void
}

// Must match PAGE_SIZE in nexus.rs, which pages by offset rather than page number.
// Only the offset calculation needs it now; last_page comes back in the response meta.
const PAGE_SIZE = 24

const SORT_VALUES = ['updatedAt', 'downloads', 'endorsements', 'relevance']

function getSavedSort(game: GameId): string {
    const saved = localStorage.getItem(`modrex:${GAMES[game].storageKey}:nexus-sort`)
    return SORT_VALUES.includes(saved as string) ? (saved as string) : 'updatedAt'
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

// The files tab hosts "Mod Manager Download", which hands the download back to
// Modrex via the nxm:// deep link, the sanctioned free-tier flow. There is no
// in-app install trigger, so ModCard's onInstall routes here. onOpen instead goes
// to the in-app detail page (ModDetailPage), matching modworkshop's ModCard.
function openOnNexus(mod: ModSummary, domain: string) {
    api.openExternal(`https://www.nexusmods.com/${domain}/mods/${mod.id}?tab=files`)
}

export function NexusBrowsePage({
    activeGame,
    isActive,
    source,
    onSourceChange,
    gamePath,
    installed,
    onRefreshInstalled,
    onGoToSettings,
    onOpenDetail,
}: Props) {
    const domain = nativeIdFor(activeGame, 'nexus')
    const [page, setPage] = useState(1)
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState(() => getSavedSort(activeGame))
    const [result, setResult] = useState<Paginated<ModSummary> | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [signedIn, setSignedIn] = useState<boolean | null>(null)
    const [sessionExpired, setSessionExpired] = useState(false)
    const [busyUid, setBusyUid] = useState<string | null>(null)
    const [downloadMap, setDownloadMap] = useState<
        ReadonlyMap<number, { downloaded: number; total: number; fileId: number }>
    >(new Map())
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const fetchIdRef = useRef(0)
    const lastFetchedRef = useRef('')
    const scrollRef = useRef<HTMLDivElement>(null)

    const sortOptions = useMemo(
        () => [
            { value: 'updatedAt', label: t('nexus.sort.lastUpdated') },
            { value: 'downloads', label: t('nexus.sort.mostDownloaded') },
            { value: 'endorsements', label: t('nexus.sort.mostEndorsed') },
            { value: 'relevance', label: t('nexus.sort.relevance') },
        ],
        []
    )

    // Nexus installs carry their nexus mod id in remoteId.
    const installedByNexusId = useMemo(() => {
        const map = new Map<number, InstalledMod>()
        for (const m of installed) {
            if (m.source === 'nexus' && m.remoteId) map.set(Number(m.remoteId), m)
        }
        return map
    }, [installed])

    async function runModAction(ins: InstalledMod, action: () => Promise<void>) {
        if (!gamePath) return
        setBusyUid(ins.uid)
        setError(null)
        try {
            await action()
            await onRefreshInstalled()
        } catch (e) {
            setError(String(e))
        } finally {
            setBusyUid(null)
        }
    }

    function handleUninstall(ins: InstalledMod) {
        void runModAction(ins, () => api.uninstallMod(ins.uid, gamePath!, activeGame))
    }

    function handleEnable(ins: InstalledMod) {
        void runModAction(ins, () => api.enableMod(ins.uid, gamePath!, activeGame))
    }

    function handleDisable(ins: InstalledMod) {
        void runModAction(ins, () => api.disableMod(ins.uid, gamePath!, activeGame))
    }

    // The nxm:// handoff runs entirely in the backend; these listeners are what
    // make the browser-initiated download visible on the cards. Progress ids are
    // "nxm:{gameId}:{modId}:{fileId}"; Nexus mod ids repeat across game domains,
    // so events for other games must be ignored. Completion only clears the entry
    // when the file matches, so a second file of the same mod keeps its progress.
    // A failure payload carries no ids (it can occur before the link is even
    // parsed), so it clears everything.
    useEffect(() => {
        const offStarted = api.onNxmInstallStarted(({ gameId, modId, fileId }) => {
            if (gameId !== activeGame) return
            setDownloadMap((prev) => new Map(prev).set(modId, { downloaded: 0, total: 0, fileId }))
        })
        const offProgress = api.onDownloadProgress(({ download_id, downloaded, total }) => {
            const [prefix, gameId, modId, fileId] = download_id.split(':')
            if (prefix !== 'nxm' || gameId !== activeGame) return
            setDownloadMap((prev) =>
                new Map(prev).set(Number(modId), { downloaded, total, fileId: Number(fileId) })
            )
        })
        const offComplete = api.onNxmInstallComplete(({ gameId, modId, fileId }) => {
            if (gameId !== activeGame) return
            setDownloadMap((prev) => {
                if (prev.get(modId)?.fileId !== fileId) return prev
                const next = new Map(prev)
                next.delete(modId)
                return next
            })
        })
        const offFailed = api.onNxmInstallFailed((e) => {
            setError(e)
            setDownloadMap(new Map())
        })
        return () => {
            offStarted()
            offProgress()
            offComplete()
            offFailed()
        }
    }, [activeGame])

    // Re-check on activation because sign-in and sign-out happen in Settings while
    // this page remains mounted in a hidden pane.
    useEffect(() => {
        if (!isActive) return
        let cancelled = false
        api.isNexusSignedIn().then((isSignedIn) => {
            if (!cancelled) setSignedIn(isSignedIn)
        })
        return () => {
            cancelled = true
        }
    }, [isActive])

    // A session that lapses while this page is open would otherwise leave the grid
    // reporting whatever the failed request said, which reads as Nexus being broken
    // rather than as a sign-in the user has to redo.
    useEffect(() => {
        const offExpired = api.onNexusSessionExpired(() => {
            setSignedIn(false)
            setSessionExpired(true)
            setError(null)
        })
        const offSignedIn = api.onNexusOAuthSignedIn(() => {
            setSignedIn(true)
            setSessionExpired(false)
            setError(null)
            // The failed attempt is still the last one recorded, so clear it or the fetch
            // effect below treats the page as already loaded for these filters.
            lastFetchedRef.current = ''
        })
        return () => {
            offExpired()
            offSignedIn()
        }
    }, [])

    useEffect(() => {
        if (!isActive || signedIn !== true || !domain) return
        const filters = JSON.stringify([page, query, sort])
        // Successful results stay valid across tab switches; only param changes
        // or a prior failure warrant hitting the rate-limited API again.
        if (filters === lastFetchedRef.current && result !== null && !error) return
        if (filters !== lastFetchedRef.current) {
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            setResult(null)
            setLoading(true)
        } else if (error) {
            setLoading(true)
        }
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(
            async () => {
                const id = ++fetchIdRef.current
                lastFetchedRef.current = filters
                setError(null)
                try {
                    const data = await api.nexusSearchMods(
                        activeGame,
                        query,
                        sort,
                        (page - 1) * PAGE_SIZE
                    )
                    if (fetchIdRef.current !== id) return
                    setResult(data)
                    setLoading(false)
                } catch (e) {
                    if (fetchIdRef.current !== id) return
                    setError(String(e))
                    setLoading(false)
                }
            },
            query ? 400 : 0
        )
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- result/error are fetch outputs, not fetch inputs; domain/activeGame are stable per mount via key={activeGame}
    }, [isActive, signedIn, page, query, sort])

    function handleQueryChange(val: string) {
        setQuery(val)
        setPage(1)
    }

    function handleSortChange(val: string) {
        localStorage.setItem(`modrex:${GAMES[activeGame].storageKey}:nexus-sort`, val)
        setSort(val)
        setPage(1)
    }

    if (!domain) return null

    const lastPage = result?.meta.last_page ?? 0

    return (
        <div className="h-full flex flex-col">
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
                </div>
                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                        <input
                            type="text"
                            placeholder={t('nexus.searchPlaceholder')}
                            value={query}
                            onChange={(e) => handleQueryChange(e.target.value)}
                            className={`w-full text-sm pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${query ? 'pr-7' : 'pr-3'}`}
                        />
                        {query && <SearchClearButton onClick={() => handleQueryChange('')} />}
                    </div>
                    <Select
                        value={sort}
                        onChange={handleSortChange}
                        options={sortOptions}
                        icon={<ArrowDownUp className="w-3.5 h-3.5 text-text-subtle" />}
                    />
                </div>
            </div>

            {/* Suppressed while signed out, because the prompt below already explains the
                situation in the user's terms. A request in flight when the session ends
                rejects after the expiry event has been handled, so its raw message would
                otherwise land on top of that prompt. */}
            {error && signedIn !== false && (
                <div className="mx-6 mt-4 px-4 py-3 bg-danger/30 border border-danger-hover rounded text-sm text-danger-text">
                    {error}
                </div>
            )}

            {signedIn === false ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-text-subtle">
                    <span>
                        {sessionExpired ? t('nexus.sessionExpiredHint') : t('nexus.signInRequired')}
                    </span>
                    <button
                        onClick={onGoToSettings}
                        className="text-xs text-accent hover:text-accent-bright underline transition-colors"
                    >
                        {t('nexus.goToSettings')}
                    </button>
                </div>
            ) : (
                <ScrollArea
                    hostClassName="flex-1"
                    ref={scrollRef}
                    className="overflow-y-auto px-6 py-4"
                >
                    {loading ? (
                        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                            {Array.from({ length: 24 }, (_, i) => (
                                <SkeletonCard key={i} />
                            ))}
                        </div>
                    ) : !result ? (
                        <div className="flex items-center justify-center h-full text-text-subtle text-sm">
                            {t('nexus.loadFailed')}
                        </div>
                    ) : result.data.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-text-subtle text-sm">
                            {t('nexus.noMods')}
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                            {result.data.map((mod) => {
                                const ins = installedByNexusId.get(mod.id)
                                return (
                                    <ModCard
                                        key={mod.id}
                                        mod={mod}
                                        installed={ins}
                                        onOpen={() => onOpenDetail(mod.id, mod)}
                                        onInstall={() => openOnNexus(mod, domain)}
                                        onUninstall={() => ins && handleUninstall(ins)}
                                        onEnable={() => ins && handleEnable(ins)}
                                        onDisable={() => ins && handleDisable(ins)}
                                        loading={
                                            ins ? ins.uid === busyUid : downloadMap.has(mod.id)
                                        }
                                        progress={downloadMap.get(mod.id) ?? null}
                                        gamePath={gamePath}
                                    />
                                )
                            })}
                        </div>
                    )}
                </ScrollArea>
            )}

            {result !== null && lastPage > 1 && (
                <div className="px-6 py-3 border-t border-border flex items-center justify-between shrink-0">
                    <span className="text-xs text-text-subtle">
                        {t('nexus.modCount', { total: result.meta.total })}
                    </span>
                    <div className="flex gap-1">
                        {buildPages(page, lastPage).map((p, i) =>
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
            )}
        </div>
    )
}

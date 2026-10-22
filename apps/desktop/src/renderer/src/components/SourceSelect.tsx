import { useEffect, useState } from 'react'
import { api } from '../api'
import { SOURCE_LABELS, sourcesForGame } from '../sources'
import { waitForForegroundClear } from '../requestPriority'
import { formatCount } from './modDetail/format'
import { SkeletonBar } from './Skeleton'
import { BetaBadge, isBetaSource } from './BetaBadge'
import { TITLE_ROW_H } from './pageHeader'
import { HeaderTab } from './HeaderTab'
import { t } from '../i18n'
import { GAMES, type GameId } from '../../../shared/types'

// Library-wide totals per (game, source), for the session. Unlike the footer count these
// do not move as the user searches, so they are fetched once and reused: re-reading them
// per keystroke would spend the ModWorkshop rate limit and the Nexus daily quota on a
// number that never changes. null means "asked, no answer" (see fetchCount).
//
// This is a shared store rather than per-component state because BOTH browse pages render
// a switcher and stay mounted at once. With local state, whichever instance's fetch was
// cancelled kept an empty map forever (its effect only re-runs on game change), so one tab
// showed counts and the other did not. Subscribers are notified on every write, so a count
// fetched by either instance lands in both, and inFlight keeps two instances from making
// the same request twice.
const countCache = new Map<string, number | null>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

const cacheKey = (gameId: string, sourceId: string) => `${gameId}:${sourceId}`

function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
        listeners.delete(fn)
    }
}

// A signed-out Nexus count caches as null (see fetchCount), but that null is recoverable:
// signing in mid-session makes the real total available. Drop every cached Nexus count on
// sign-in so ensureCount re-fetches instead of honouring the stale null forever. Registered
// once at module load; the listener lives for the app's lifetime.
api.onNexusOAuthSignedIn(() => {
    const games = dropNexusCounts()
    if (games.length === 0) return
    // Flip the visible counts to skeletons immediately, then re-fetch the real totals.
    for (const l of listeners) l()
    for (const g of games) ensureCount(g, 'nexus')
})

// A lapsed session makes the cached total a claim about a library this app can no longer
// reach, so it is dropped without re-fetching: fetchCount would only see the signed-out
// state and cache the same null again.
api.onNexusSessionExpired(() => {
    if (dropNexusCounts().length === 0) return
    for (const l of listeners) l()
})

function dropNexusCounts(): GameId[] {
    const games: GameId[] = []
    for (const key of [...countCache.keys()]) {
        if (!key.endsWith(':nexus')) continue
        countCache.delete(key)
        games.push(key.slice(0, -':nexus'.length) as GameId)
    }
    return games
}

function ensureCount(gameId: GameId, sourceId: string): void {
    const key = cacheKey(gameId, sourceId)
    if (countCache.has(key) || inFlight.has(key)) return
    inFlight.set(
        key,
        (async () => {
            // Yield to whatever the user is actually waiting on; these totals are
            // supplementary and share the same rate-limited connection.
            await waitForForegroundClear()
            const total = await fetchCount(gameId, sourceId).catch(() => null)
            countCache.set(key, total)
            inFlight.delete(key)
            for (const l of listeners) l()
        })()
    )
}

/**
 * The total this source carries for this game, ignoring any active filter. Both requests
 * ask for the smallest possible page, since only meta.total is wanted.
 *
 * Returns null when there is no answer to be had rather than surfacing an error: the count
 * is supplementary, and the common null case is simply not being signed in to Nexus, which
 * is an expected state and not a failure. The switcher stays usable either way.
 */
async function fetchCount(gameId: GameId, sourceId: string): Promise<number | null> {
    if (sourceId === 'nexus') {
        if (!(await api.isNexusSignedIn())) return null
        const page = await api.nexusSearchMods(gameId, '', 'downloads', 0)
        return page.meta.total
    }
    const workshopId = GAMES[gameId].workshopId
    if (workshopId === undefined) return null
    const page = await api.listMods(workshopId, { limit: 1 })
    return page.meta.total
}

function cachedCounts(gameId: GameId): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    for (const s of sourcesForGame(gameId)) {
        const hit = countCache.get(cacheKey(gameId, s.id))
        if (hit !== undefined) out[s.id] = hit
    }
    return out
}

/**
 * Picks which source Browse is showing. Both stay on screen rather than collapsing into a
 * dropdown, so a user who never opens a menu still learns the second one exists. Renders
 * a plain caption when the game has only one source, as with RAID, which has no Nexus presence.
 *
 * Results are deliberately NOT merged across sources. The two have separate search engines,
 * so their sort options differ, their relevance scores are not comparable, and their page
 * cursors are independent. One source is active at a time and each keeps its own query,
 * sort and page.
 */
export function SourceSelect({
    activeGame,
    value,
    onChange,
}: {
    activeGame: GameId
    value: string
    onChange: (next: string) => void
}) {
    const sources = sourcesForGame(activeGame)
    const [counts, setCounts] = useState<Record<string, number | null>>(() =>
        cachedCounts(activeGame)
    )

    useEffect(() => {
        const sync = () => setCounts(cachedCounts(activeGame))
        const unsubscribe = subscribe(sync)
        for (const s of sourcesForGame(activeGame)) ensureCount(activeGame, s.id)
        sync()
        return unsubscribe
    }, [activeGame])

    // One source is nothing to choose, so it reads as a caption to the title, not a tab.
    if (sources.length === 1) {
        const s = sources[0]!
        return (
            <div className={`flex flex-col justify-center px-4 shrink-0 ${TITLE_ROW_H}`}>
                <span className="relative flex items-center gap-1.5 text-sm font-medium leading-tight text-text-muted">
                    <SourceName id={s.id} />
                </span>
                <span className="relative flex h-3.5 items-center text-[11px] leading-none text-text-subtle">
                    <SourceCount total={counts[s.id]} />
                </span>
            </div>
        )
    }

    return (
        <div className={`flex items-stretch gap-1 shrink-0 ${TITLE_ROW_H}`}>
            {sources.map((s) => {
                const active = value === s.id
                const total = counts[s.id]
                return (
                    <HeaderTab
                        key={s.id}
                        active={active}
                        onClick={() => onChange(s.id)}
                        label={<SourceName id={s.id} />}
                        count={<SourceCount total={total} />}
                    />
                )
            })}
        </div>
    )
}

function SourceName({ id }: { id: string }) {
    return (
        <>
            {SOURCE_LABELS[id] ?? id}
            {isBetaSource(id) && <BetaBadge />}
        </>
    )
}

// Three states that must not look alike: loading shows a skeleton, no answer (signed out
// of Nexus) shows nothing, and a real count renders. The fixed height is what keeps all
// three the same size, so the header cannot jump as counts arrive.
function SourceCount({ total }: { total: number | null | undefined }) {
    if (total === undefined) return <SkeletonBar className="h-2.5 w-14 animate-pulse" />
    if (total === null) return null
    return t('browse.modCount', { total: formatCount(total) })
}

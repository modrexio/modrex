import { useState, useEffect, useRef, useMemo } from 'react'
import type { ModSummary, InstalledMod, GameId } from '../../../shared/types'
import { getInstalledMetaEntry, fetchInstalledModsMeta, INSTALLED_META_TTL_MS } from '../modCache'
import {
    getNexusInstalledMetaEntry,
    fetchInstalledNexusModsMeta,
    useNexusAuthEpoch,
} from '../nexusModCache'
import { getLocalImage } from '../thumbnailCache'
import { hasCatalogLink } from './installedUtils'

function isModworkshopSourced(m: InstalledMod): boolean {
    return !m.source || m.source === 'modworkshop'
}

export function useModData(
    installed: InstalledMod[],
    workshopId: number,
    gameId: GameId
): {
    modData: Map<number, ModSummary>
    failedIds: Set<number>
    updatable: InstalledMod[]
} {
    const [modData, setModData] = useState<Map<number, ModSummary>>(new Map())
    const [failedIds, setFailedIds] = useState<Set<number>>(new Set())
    const fetchedAt = useRef<Map<number, number>>(new Map())
    // Nexus installs carry a negated id (see install_nexus_download), keyed here off
    // that same id so modData/failedIds stay one shared map/set for both sources.
    const nexusFetchedAt = useRef<Map<number, number>>(new Map())
    const installedKey = useRef<string>('')
    const nexusAuthEpoch = useNexusAuthEpoch()
    const seenAuthEpoch = useRef(nexusAuthEpoch)

    useEffect(() => {
        if (installed.length === 0) {
            installedKey.current = ''
            setModData(new Map())
            setFailedIds(new Set())
            fetchedAt.current.clear()
            nexusFetchedAt.current.clear()
            return
        }

        // Signing in again retires every Nexus outcome recorded against the previous
        // session: those mods failed on a token that no longer exists. Both the fetched-at
        // stamps (which back off failures for the full TTL) and failedIds (which pins the
        // rows to their local-name fallback) have to go, or the list keeps the metadata it
        // could not fetch until the app restarts.
        const authChanged = seenAuthEpoch.current !== nexusAuthEpoch
        if (authChanged) {
            seenAuthEpoch.current = nexusAuthEpoch
            nexusFetchedAt.current.clear()
            const nexusInsIds = new Set(
                installed.filter((m) => m.source === 'nexus').map((m) => m.id)
            )
            setFailedIds((prev) => {
                const next = new Set([...prev].filter((id) => !nexusInsIds.has(id)))
                return next.size === prev.size ? prev : next
            })
        }

        // Bail early when the set of mod ids has not changed, which avoids redundant
        // sync pre-populate on every focus refresh that produces a new array reference.
        // A new session bypasses it: the ids are the same, the answers are not.
        const nextKey = installed
            .map((m) => m.id)
            .sort((a, b) => a - b)
            .join(',')
        if (!authChanged && nextKey === installedKey.current) return
        installedKey.current = nextKey

        const now = Date.now()
        const fromCache: [number, ModSummary][] = []
        for (const m of installed) {
            if (!isModworkshopSourced(m)) continue
            const remoteId = Number(m.remoteId)
            if (!Number.isFinite(remoteId) || remoteId <= 0) continue
            // getInstalledMetaEntry/fetchInstalledModsMeta are keyed by the real
            // modworkshop id (they call modworkshop's own ids[] API), whereas m.id is opaque
            // local key (see sources::source_native_local_id) and never sent anywhere.
            const entry = getInstalledMetaEntry(remoteId)
            if (!entry) continue
            fromCache.push([m.id, entry.mod])
            // Mark as fetched so fresh entries skip the API call below
            if (now - entry.fetchedAt < INSTALLED_META_TTL_MS) {
                fetchedAt.current.set(m.id, entry.fetchedAt)
            }
        }
        // Same pre-populate shape, keyed off the mod's own (positive) remoteId against
        // the Nexus-specific cache below instead of the ids[]-backed one above.
        for (const m of installed) {
            if (m.source !== 'nexus') continue
            const nexusModId = Number(m.remoteId)
            if (!Number.isFinite(nexusModId) || nexusModId <= 0) continue
            const entry = getNexusInstalledMetaEntry(gameId, nexusModId)
            if (!entry) continue
            fromCache.push([m.id, entry.mod])
            if (now - entry.fetchedAt < INSTALLED_META_TTL_MS) {
                nexusFetchedAt.current.set(m.id, entry.fetchedAt)
            }
        }
        for (const [, mod] of fromCache) {
            // Pre-warm the full-size variant, which is what ModCard renders.
            if (mod.thumbnail?.file) getLocalImage(mod.thumbnail.file, true).catch(() => {})
        }
        if (fromCache.length > 0) {
            setModData((prev) => {
                const next = new Map(prev)
                let changed = false
                for (const [id, mod] of fromCache) {
                    if (!next.has(id)) {
                        next.set(id, mod)
                        changed = true
                    }
                }
                return changed ? next : prev
            })
        }

        const stale = installed.filter((m) => {
            if (!isModworkshopSourced(m) || !hasCatalogLink(m)) return false
            const t = fetchedAt.current.get(m.id)
            return t === undefined || now - t >= INSTALLED_META_TTL_MS
        })
        if (stale.length > 0) {
            const insIdByRemoteId = new Map<number, number>()
            for (const m of stale) {
                const remoteId = Number(m.remoteId)
                if (Number.isFinite(remoteId) && remoteId > 0) {
                    insIdByRemoteId.set(remoteId, m.id)
                }
            }
            fetchInstalledModsMeta(workshopId, [...insIdByRemoteId.keys()]).then(
                ({ mods, failedIds: failed }) => {
                    const fetchedNow = Date.now()
                    for (const m of stale) fetchedAt.current.set(m.id, fetchedNow)
                    const updated: [number, ModSummary][] = []
                    for (const [remoteId, insId] of insIdByRemoteId) {
                        const mod = mods.get(remoteId)
                        if (!mod) continue
                        updated.push([insId, mod])
                        // Pre-warm the full-size variant, which is what ModCard renders.
                        if (mod.thumbnail?.file) {
                            getLocalImage(mod.thumbnail.file, true).catch(() => {})
                        }
                    }
                    if (updated.length > 0) {
                        setModData((prev) => {
                            const next = new Map(prev)
                            for (const [id, mod] of updated) next.set(id, mod)
                            return next
                        })
                    }
                    if (failed.length > 0) {
                        const failedInsIds = failed
                            .map((remoteId) => insIdByRemoteId.get(remoteId))
                            .filter((id): id is number => id !== undefined)
                        setFailedIds((prev) => new Set([...prev, ...failedInsIds]))
                    }
                }
            )
        }

        // Nexus has no ids[]-style batch endpoint, so this goes one request at a time
        // against an undocumented hourly quota (fetchInstalledNexusModsMeta) instead of
        // the single bulk call above. onResult reports each mod as it resolves rather
        // than waiting for the whole trickle, since that can take a while for a large
        // installed list.
        const staleNexus = installed.filter((m) => {
            if (m.source !== 'nexus') return false
            const t = nexusFetchedAt.current.get(m.id)
            return t === undefined || now - t >= INSTALLED_META_TTL_MS
        })
        if (staleNexus.length > 0) {
            const insIdByNexusModId = new Map<number, number>()
            for (const m of staleNexus) {
                const nexusModId = Number(m.remoteId)
                if (Number.isFinite(nexusModId) && nexusModId > 0) {
                    insIdByNexusModId.set(nexusModId, m.id)
                }
            }
            fetchInstalledNexusModsMeta(
                gameId,
                [...insIdByNexusModId.keys()],
                (nexusModId, mod) => {
                    const insId = insIdByNexusModId.get(nexusModId)
                    if (insId === undefined) return
                    nexusFetchedAt.current.set(insId, Date.now())
                    if (mod) {
                        if (mod.thumbnail?.file) {
                            getLocalImage(mod.thumbnail.file, true).catch(() => {})
                        }
                        setModData((prev) => new Map(prev).set(insId, mod))
                    } else {
                        setFailedIds((prev) => new Set(prev).add(insId))
                    }
                }
            ).catch(() => {})
        }
    }, [installed, workshopId, gameId, nexusAuthEpoch])

    const updatable = useMemo(() => {
        const installedVersions = new Set(installed.map((m) => `${m.id}:${m.version}`))
        const seenIds = new Set<number>()
        return installed.filter((ins) => {
            if (seenIds.has(ins.id)) return false
            seenIds.add(ins.id)
            if (ins.missing) return false
            // No comparable installed version, so staleness is unknowable and a prompt
            // would nag forever. Outdated is the deliberate exception: it means a SHA256
            // check already confirmed the installed bytes differ from the current file.
            if (ins.updateStatus === 'unknown') return false
            if (ins.updateStatus !== 'outdated' && !ins.version) return false
            const mod = modData.get(ins.id)
            if (!mod) return false
            if (mod.version === ins.version) return false
            if (installedVersions.has(`${ins.id}:${mod.version}`)) return false
            return true
        })
    }, [installed, modData])

    return { modData, failedIds, updatable }
}

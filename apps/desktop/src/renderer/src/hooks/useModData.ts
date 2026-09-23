import { useState, useEffect } from 'react'
import type { ModSummary, InstalledMod, GameId } from '../../../shared/types'
import { getInstalledMetaEntry, fetchInstalledModsMeta, INSTALLED_META_TTL_MS } from '../modCache'
import {
    getNexusInstalledMetaEntry,
    fetchInstalledNexusModsMeta,
    useNexusAuthEpoch,
} from '../nexusModCache'
import { useModVersions } from './useModVersions'
import type { VersionState } from '../modVersions'
import { updatableMods } from '../updatePolicy'
import { getLocalImage } from '../thumbnailCache'

export function useModData(
    installed: InstalledMod[],
    workshopId: number | undefined,
    gameId: GameId
) {
    const [modData, setModData] = useState(new Map<number, ModSummary>())
    const [failedIds, setFailedIds] = useState(new Set<number>())
    const [nexusVersions, setNexusVersions] = useState(
        new Map<number, { state: VersionState; checkedAt: number }>()
    )
    const [clock, setClock] = useState(0)
    const nexusAuthEpoch = useNexusAuthEpoch()
    const workshop = installed.filter(
        (mod) =>
            (!mod.source || mod.source === 'modworkshop') &&
            Number.isInteger(Number(mod.remoteId)) &&
            Number(mod.remoteId) > 0 &&
            Number(mod.remoteId) <= 0xffff_ffff
    )
    const remoteVersions = useModVersions(workshop.map((mod) => Number(mod.remoteId)))
    const key = installed
        .map((mod) => [mod.id, mod.source, mod.remoteId].join(':'))
        .sort()
        .join(',')

    useEffect(() => {
        let cancelled = false
        let running = false
        const attempted = new Map<number, number>()
        const initial = new Map<number, ModSummary>()
        const initialNexusVersions = new Map<number, { state: VersionState; checkedAt: number }>()
        for (const mod of installed) {
            const nexusEntry =
                mod.source === 'nexus'
                    ? getNexusInstalledMetaEntry(gameId, Number(mod.remoteId))
                    : undefined
            const workshopEntry =
                !mod.source || mod.source === 'modworkshop'
                    ? getInstalledMetaEntry(Number(mod.remoteId))
                    : undefined
            const entry = nexusEntry ?? workshopEntry
            if (entry) {
                initial.set(mod.id, entry.mod)
                if (Date.now() - entry.fetchedAt < INSTALLED_META_TTL_MS) {
                    attempted.set(mod.id, entry.fetchedAt)
                }
                if (nexusEntry) {
                    const state: VersionState =
                        nexusEntry.mod.version === ''
                            ? { status: 'unversioned' }
                            : { status: 'known', version: nexusEntry.mod.version }
                    initialNexusVersions.set(mod.id, { state, checkedAt: nexusEntry.fetchedAt })
                }
                if (entry.mod.thumbnail?.file) void getLocalImage(entry.mod.thumbnail.file, true)
            }
        }
        setModData(initial)
        setFailedIds(new Set())
        setNexusVersions(initialNexusVersions)

        function accept(
            source: 'nexus' | 'modworkshop',
            remoteId: number,
            mod: ModSummary | null,
            version?: string
        ) {
            if (cancelled) return
            for (const ins of installed) {
                if ((ins.source ?? 'modworkshop') !== source || Number(ins.remoteId) !== remoteId)
                    continue
                attempted.set(ins.id, Date.now())
                setFailedIds((previous) => {
                    const next = new Set(previous)
                    if (mod) next.delete(ins.id)
                    else next.add(ins.id)
                    return next
                })
                if (mod) {
                    setModData((previous) => new Map(previous).set(ins.id, mod))
                    if (mod.thumbnail?.file) void getLocalImage(mod.thumbnail.file, true)
                }
                if (source === 'nexus') {
                    const state: VersionState =
                        version === undefined
                            ? { status: 'failed', error: 'Nexus metadata unavailable' }
                            : version === ''
                              ? { status: 'unversioned' }
                              : { status: 'known', version }
                    setNexusVersions((previous) =>
                        new Map(previous).set(ins.id, { state, checkedAt: Date.now() })
                    )
                }
            }
        }

        async function refresh() {
            if (running) return
            running = true
            setClock(Date.now())
            try {
                const workshopIds: number[] = []
                const nexusIds: number[] = []
                for (const mod of installed) {
                    const id = Number(mod.remoteId)
                    if (!Number.isInteger(id) || id <= 0) continue
                    if (Date.now() - (attempted.get(mod.id) ?? -Infinity) < INSTALLED_META_TTL_MS)
                        continue
                    if (mod.source === 'nexus') nexusIds.push(id)
                    else if ((!mod.source || mod.source === 'modworkshop') && id <= 0xffff_ffff)
                        workshopIds.push(id)
                }
                await Promise.all([
                    workshopId === undefined || !workshopIds.length
                        ? Promise.resolve()
                        : fetchInstalledModsMeta(workshopId, workshopIds).then(
                              ({ mods, failedIds }) => {
                                  for (const [id, mod] of mods) accept('modworkshop', id, mod)
                                  for (const id of failedIds) accept('modworkshop', id, null)
                              }
                          ),
                    !nexusIds.length
                        ? Promise.resolve()
                        : fetchInstalledNexusModsMeta(gameId, nexusIds, (id, mod) =>
                              accept('nexus', id, mod, mod?.version)
                          ),
                ])
            } finally {
                running = false
            }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 30_000)
        const focus = () => void refresh()
        window.addEventListener('focus', focus)
        return () => {
            cancelled = true
            clearInterval(timer)
            window.removeEventListener('focus', focus)
        }
        // Identity changes restart ownership; version/enabled changes do not.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, workshopId, gameId, nexusAuthEpoch])

    const versions = new Map<number, VersionState>()
    for (const mod of workshop)
        versions.set(mod.id, remoteVersions.get(Number(mod.remoteId)) ?? { status: 'pending' })
    for (const [id, entry] of nexusVersions) {
        const state = entry.state
        versions.set(
            id,
            clock - entry.checkedAt >= INSTALLED_META_TTL_MS &&
                (state.status === 'known' || state.status === 'unversioned')
                ? { status: 'stale', previous: state }
                : state
        )
    }
    const updatable = updatableMods(installed, versions, modData)
    const updateVersions = new Map<number, string>()
    for (const mod of updatable) {
        const state = versions.get(mod.id)
        if (state?.status === 'known') updateVersions.set(mod.id, state.version)
    }
    return { modData, failedIds, versions, updateVersions, updatable }
}

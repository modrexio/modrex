import { api } from './api'
import { waitForForegroundClear } from './requestPriority'

export type VersionState =
    | { status: 'pending' }
    | { status: 'known'; version: string }
    | { status: 'unversioned' }
    | {
          status: 'stale'
          previous: { status: 'known'; version: string } | { status: 'unversioned' }
      }
    | { status: 'missing' }
    | { status: 'failed'; error: string }

type Result = Awaited<ReturnType<typeof api.getModVersions>>[number]
type Entry = { result: Result; checkedAt: number; retryAt: number; failures: number }
export const VERSION_TTL_MS = 30 * 60 * 1000
// Renews an entry before it goes stale. useModVersions polls every 30 seconds.
const REFRESH_LEAD_MS = 60_000

// This cache is provider-global: ModWorkshop IDs do not repeat between games.
// Transport injection lets tests exercise the same batching and retry state as the UI.
export function createVersionCache(
    fetchVersions: (ids: number[]) => Promise<Result[]>,
    now = Date.now
) {
    const entries = new Map<number, Entry>()
    const pending = new Map<number, Promise<void>>()
    const queued = new Map<number, { resolve: () => void; generation: number }>()
    const generations = new Map<number, number>()
    const listeners = new Set<() => void>()
    let revision = 0
    let scheduled = false

    function notify() {
        revision++
        for (const listener of listeners) listener()
    }

    function read(id: number): VersionState {
        const entry = entries.get(id)
        if (!entry) return { status: 'pending' }
        const result = entry.result
        if (result.status === 'known') {
            const state = { status: 'known' as const, version: result.version }
            return now() - entry.checkedAt >= VERSION_TTL_MS
                ? { status: 'stale', previous: state }
                : state
        }
        if (result.status === 'unversioned') {
            const state = { status: 'unversioned' as const }
            return now() - entry.checkedAt >= VERSION_TTL_MS
                ? { status: 'stale', previous: state }
                : state
        }
        if (result.status === 'failed') return { status: 'failed', error: result.error }
        return { status: 'missing' }
    }

    async function flush() {
        scheduled = false
        const batch = [...queued.entries()]
        queued.clear()
        for (let offset = 0; offset < batch.length; offset += 100) {
            const chunk = batch.slice(offset, offset + 100)
            const ids = chunk.map(([id]) => id)
            let results: Result[]
            try {
                results = await fetchVersions(ids)
            } catch (error) {
                results = ids.map((id) => ({ id, status: 'failed', error: String(error) }))
            }
            const byId = new Map(results.map((result) => [result.id, result]))
            for (const [id, request] of chunk) {
                const result = byId.get(id) ?? {
                    id,
                    status: 'failed',
                    error: 'Incomplete version command response',
                }
                if ((generations.get(id) ?? 0) === request.generation) {
                    const failures =
                        result.status === 'failed' ? (entries.get(id)?.failures ?? 0) + 1 : 0
                    const delay = failures
                        ? Math.min(VERSION_TTL_MS, 60_000 * 2 ** Math.min(failures - 1, 5))
                        : VERSION_TTL_MS - REFRESH_LEAD_MS
                    entries.set(id, { result, checkedAt: now(), retryAt: now() + delay, failures })
                }
                pending.delete(id)
                request.resolve()
            }
            notify()
        }
    }

    function refresh(ids: readonly number[]): Promise<void> {
        const waits: Promise<void>[] = []
        for (const id of new Set(ids)) {
            if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff) {
                throw new Error(`Invalid ModWorkshop ID: ${id}`)
            }
            const running = pending.get(id)
            if (running) {
                waits.push(running)
                continue
            }
            const entry = entries.get(id)
            if (entry && now() < entry.retryAt) continue
            const generation = generations.get(id) ?? 0
            const promise = new Promise<void>((resolve) => queued.set(id, { resolve, generation }))
            pending.set(id, promise)
            waits.push(promise)
        }
        if (queued.size && !scheduled) {
            scheduled = true
            queueMicrotask(() => void flush())
        }
        return Promise.all(waits).then(() => undefined)
    }

    return {
        read,
        refresh,
        record(id: number, version: string) {
            generations.set(id, (generations.get(id) ?? 0) + 1)
            entries.set(id, {
                result:
                    version === ''
                        ? { id, status: 'unversioned' }
                        : { id, status: 'known', version },
                checkedAt: now(),
                retryAt: now() + VERSION_TTL_MS - REFRESH_LEAD_MS,
                failures: 0,
            })
            notify()
        },
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        snapshot: () => revision,
    }
}

export const modVersions = createVersionCache(async (ids) => {
    await waitForForegroundClear()
    return api.getModVersions(ids)
})

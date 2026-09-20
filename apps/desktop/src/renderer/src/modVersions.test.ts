import { describe, expect, it, vi } from 'vitest'
vi.mock('./api', () => ({ api: { getModVersions: vi.fn() } }))
import { createVersionCache, VERSION_TTL_MS } from './modVersions'

describe('ModWorkshop version observations', () => {
    it('coalesces overlapping consumers, deduplicates and chunks 101 IDs', async () => {
        const fetch = vi.fn(async (ids: number[]) =>
            ids.map((id) => ({ status: 'known' as const, id, version: 'opaque release' }))
        )
        const cache = createVersionCache(fetch)
        await cache.refresh([])
        expect(fetch).not.toHaveBeenCalled()
        await Promise.all([
            cache.refresh(Array.from({ length: 101 }, (_, i) => i + 1)),
            cache.refresh([1, 1, 2]),
        ])
        expect(fetch.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1])
        expect(cache.read(1)).toMatchObject({ status: 'known', version: 'opaque release' })
        await cache.refresh([1, 101])
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('expires even with unchanged IDs and does not use stale data as fresh', async () => {
        let now = 0
        const fetch = vi.fn(async () => [{ id: 1, status: 'known' as const, version: 'v1' }])
        const cache = createVersionCache(fetch, () => now)
        await cache.refresh([1])
        now = VERSION_TTL_MS
        expect(cache.read(1)).toMatchObject({ status: 'stale', previous: { version: 'v1' } })
        await cache.refresh([1])
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('distinguishes unversioned, missing and failed, and retries only failed due IDs', async () => {
        let now = 0
        const fetch = vi
            .fn()
            .mockResolvedValueOnce([
                { id: 1, status: 'unversioned' },
                { id: 2, status: 'missing' },
                { id: 3, status: 'failed', error: '429' },
            ])
            .mockResolvedValue([{ id: 3, status: 'known', version: 'fixed' }])
        const cache = createVersionCache(fetch, () => now)
        await cache.refresh([1, 2, 3])
        expect([1, 2, 3].map((id) => cache.read(id).status)).toEqual([
            'unversioned',
            'missing',
            'failed',
        ])
        await cache.refresh([3])
        expect(fetch).toHaveBeenCalledTimes(1)
        now = 60_000
        await cache.refresh([1, 2, 3])
        expect(fetch).toHaveBeenLastCalledWith([3])
        expect(cache.read(3)).toMatchObject({ status: 'known', version: 'fixed' })
    })

    it('retains successful chunks when another batch throws', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: 'unversioned' }))
            )
            .mockRejectedValueOnce(new Error('offline'))
        const cache = createVersionCache(fetch)
        await cache.refresh(Array.from({ length: 101 }, (_, i) => i + 1))
        expect(cache.read(1).status).toBe('unversioned')
        expect(cache.read(101)).toMatchObject({ status: 'failed', error: 'Error: offline' })
    })

    it('records detail revalidation and clears obsolete failures', async () => {
        const cache = createVersionCache(
            vi.fn().mockResolvedValue([{ id: 1, status: 'failed', error: 'offline' }])
        )
        await cache.refresh([1])
        cache.record(1, 'author release')
        expect(cache.read(1)).toEqual({ status: 'known', version: 'author release' })
        cache.record(1, '')
        expect(cache.read(1)).toEqual({ status: 'unversioned' })
    })

    it('does not let an older in-flight batch overwrite detail revalidation', async () => {
        let resolve!: (results: Array<{ id: number; status: 'known'; version: string }>) => void
        const cache = createVersionCache(
            () =>
                new Promise((done) => {
                    resolve = done
                })
        )
        const refresh = cache.refresh([1])
        await Promise.resolve()
        cache.record(1, 'detail')
        resolve([{ id: 1, status: 'known', version: 'older batch' }])
        await refresh
        expect(cache.read(1)).toEqual({ status: 'known', version: 'detail' })
    })
})

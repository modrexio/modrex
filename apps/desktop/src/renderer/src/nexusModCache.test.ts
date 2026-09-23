import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type * as NexusModCacheMod from './nexusModCache'
import type { Mod } from '../../shared/types'

function makeMod(id: number): Mod {
    return {
        id,
        name: `Mod ${id}`,
        desc: '',
        short_desc: '',
        version: '1.0',
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: '',
        bumped_at: '',
        category_id: 0,
        has_download: false,
        disable_mod_managers: null,
        download_type: null,
        thumbnail: null,
        download: null,
        user: { id: null, name: 'Test', donation_url: null, avatar: null, avatar_has_thumb: null },
        download_id: null,
        files_are_versions: null,
        changelog: null,
        instructions: null,
        license: null,
        repo_url: null,
        donation: null,
        banner: null,
        images: [],
        dependencies: [],
        instructs_template: null,
        tags: [],
        members: [],
    }
}

let mockNexusGetModDetail: ReturnType<typeof vi.fn>
let cache!: typeof NexusModCacheMod

beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    mockNexusGetModDetail = vi.fn()
    vi.doMock('./api', () => ({
        api: {
            nexusGetModDetail: mockNexusGetModDetail,
            // Subscribed to at module load to track Nexus sign-ins.
            onNexusOAuthSignedIn: () => () => {},
        },
    }))

    cache = await import('./nexusModCache')
})

afterEach(() => {
    vi.useRealTimers()
})

describe('getCachedNexusMod', () => {
    it('calls api.nexusGetModDetail on a miss and caches the result', async () => {
        const mod = makeMod(1)
        mockNexusGetModDetail.mockResolvedValue(mod)
        const result = await cache.getCachedNexusMod('pd3', 1)
        expect(mockNexusGetModDetail).toHaveBeenCalledWith('pd3', 1)
        expect(result).toBe(mod)
        expect(cache.getNexusModCacheEntry('pd3', 1)!.mod).toBe(mod)
    })

    it('keys by gameId so the same numeric id in two games never collides', async () => {
        mockNexusGetModDetail
            .mockResolvedValueOnce(makeMod(1))
            .mockResolvedValueOnce({ ...makeMod(1), name: 'Crime Boss version' })
        await cache.getCachedNexusMod('pd3', 1)
        await cache.getCachedNexusMod('cb', 1)
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(2)
        expect(cache.getNexusModCacheEntry('pd3', 1)!.mod.name).toBe('Mod 1')
        expect(cache.getNexusModCacheEntry('cb', 1)!.mod.name).toBe('Crime Boss version')
    })
})

describe('fetchInstalledNexusModsMeta', () => {
    it('fetches every id one at a time and caches each result', async () => {
        mockNexusGetModDetail.mockResolvedValueOnce(makeMod(1)).mockResolvedValueOnce(makeMod(2))
        const promise = cache.fetchInstalledNexusModsMeta('pd3', [1, 2])
        await vi.runAllTimersAsync()
        const { mods, failedIds } = await promise
        expect(mods.get(1)!.id).toBe(1)
        expect(mods.get(2)!.id).toBe(2)
        expect(failedIds).toEqual([])
        expect(cache.getNexusInstalledMetaEntry('pd3', 1)).toBeDefined()
        expect(cache.getNexusInstalledMetaEntry('pd3', 2)).toBeDefined()
    })

    it('staggers requests instead of firing them all at once', async () => {
        mockNexusGetModDetail.mockResolvedValue(makeMod(1))
        const promise = cache.fetchInstalledNexusModsMeta('pd3', [1, 2, 3])
        await vi.advanceTimersByTimeAsync(0)
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(2000)
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(2000)
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(3)
        await promise
    })

    it('reports a per-id failure without aborting the rest of the trickle', async () => {
        mockNexusGetModDetail
            .mockRejectedValueOnce(new Error('nexus API 429'))
            .mockResolvedValueOnce(makeMod(2))
        const promise = cache.fetchInstalledNexusModsMeta('pd3', [1, 2])
        await vi.runAllTimersAsync()
        const { mods, failedIds } = await promise
        expect(failedIds).toEqual([1])
        expect(mods.has(1)).toBe(false)
        expect(mods.get(2)!.id).toBe(2)
    })

    it('calls onResult for each mod as it resolves, not only once the trickle finishes', async () => {
        mockNexusGetModDetail
            .mockResolvedValueOnce(makeMod(1))
            .mockRejectedValueOnce(new Error('nexus API 429'))
        const seen: [number, boolean][] = []
        const promise = cache.fetchInstalledNexusModsMeta('pd3', [1, 2], (modId, mod) =>
            seen.push([modId, mod !== null])
        )
        await vi.runAllTimersAsync()
        await promise
        expect(seen).toEqual([
            [1, true],
            [2, false],
        ])
    })
})

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
        legacy_markup: false,
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

let signedIn!: () => void
let mockNexusCheckFileUpdate: ReturnType<typeof vi.fn>
let mockNexusGetModDetail: ReturnType<typeof vi.fn>
let cache!: typeof NexusModCacheMod

beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    mockNexusCheckFileUpdate = vi.fn()
    mockNexusGetModDetail = vi.fn()
    vi.doMock('./api', () => ({
        api: {
            nexusGetModDetail: mockNexusGetModDetail,
            nexusCheckFileUpdate: mockNexusCheckFileUpdate,
            // Subscribed to at module load to track Nexus sign-ins.
            onNexusOAuthSignedIn: (callback: () => void) => {
                signedIn = callback
                return () => {}
            },
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

describe('installed Nexus file checks', () => {
    it('shares in-flight work, caches results for 30 minutes and isolates game, mod and file', async () => {
        mockNexusCheckFileUpdate.mockResolvedValue({ status: 'current' })
        const first = cache.getCachedNexusFileUpdate('pd3', 1, 10)
        const duplicate = cache.getCachedNexusFileUpdate('pd3', 1, 10)
        expect(duplicate).toBe(first)
        await vi.runAllTimersAsync()
        await first
        await cache.getCachedNexusFileUpdate('pd3', 1, 10)
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(1)
        for (const [game, mod, file] of [
            ['cb', 1, 10],
            ['pd3', 2, 10],
            ['pd3', 1, 11],
        ] as const) {
            const request = cache.getCachedNexusFileUpdate(game, mod, file)
            await vi.runAllTimersAsync()
            await request
        }
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(4)
        vi.advanceTimersByTime(30 * 60 * 1000)
        expect(cache.getNexusFileUpdateEntry('pd3', 1, 10)).toBeUndefined()
        const refresh = cache.getCachedNexusFileUpdate('pd3', 1, 10)
        await vi.runAllTimersAsync()
        await refresh
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(5)
    })

    it('records and caches failures without marking the installed file current', async () => {
        mockNexusCheckFileUpdate.mockRejectedValue(new Error('nexus API 429'))
        const request = cache.getCachedNexusFileUpdate('pd3', 1, 10)
        await vi.runAllTimersAsync()
        const state = await request
        expect(state).toMatchObject({ status: 'failed', error: 'Error: nexus API 429' })
        expect(await cache.getCachedNexusFileUpdate('pd3', 1, 10)).toBe(state)
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(1)
    })

    it('serializes file checks with metadata requests and respects the foreground gate', async () => {
        const priority = await import('./requestPriority')
        priority.markForegroundActivity()
        mockNexusGetModDetail.mockResolvedValue(makeMod(1))
        mockNexusCheckFileUpdate.mockResolvedValue({ status: 'unknown' })
        const metadata = cache.fetchInstalledNexusModsMeta('pd3', [1])
        const file = cache.getCachedNexusFileUpdate('pd3', 1, 10)
        await vi.advanceTimersByTimeAsync(1400)
        expect(mockNexusGetModDetail).not.toHaveBeenCalled()
        expect(mockNexusCheckFileUpdate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(200)
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(1)
        expect(mockNexusCheckFileUpdate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1999)
        expect(mockNexusCheckFileUpdate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(1)
        await Promise.all([metadata, file])
    })
})

it('retries failed file checks after a new sign-in while retaining successful checks', async () => {
    mockNexusCheckFileUpdate
        .mockRejectedValueOnce(new Error('expired token'))
        .mockResolvedValue({ status: 'current' })
    const failed = cache.getCachedNexusFileUpdate('pd3', 1, 10)
    const success = cache.getCachedNexusFileUpdate('pd3', 1, 11)
    await vi.runAllTimersAsync()
    expect((await failed).status).toBe('failed')
    const successfulEntry = await success
    signedIn()
    expect(cache.getNexusFileUpdateEntry('pd3', 1, 10)).toBeUndefined()
    expect(cache.getNexusFileUpdateEntry('pd3', 1, 11)).toBe(successfulEntry)
    const retry = cache.getCachedNexusFileUpdate('pd3', 1, 10)
    await vi.runAllTimersAsync()
    expect((await retry).status).toBe('known')
    expect(mockNexusCheckFileUpdate).toHaveBeenCalledTimes(3)
})

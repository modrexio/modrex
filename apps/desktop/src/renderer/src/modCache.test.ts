import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type * as ModCacheMod from './modCache'
import type { Mod, ModFile, ModLink } from '../../shared/types'

const TTL_MS = 5 * 60 * 1000
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'modrex:mod-cache'

function makeLocalStorage() {
    const store: Record<string, string> = {}
    return {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
            store[key] = value
        },
        removeItem: (key: string) => {
            delete store[key]
        },
    }
}

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

function makeFile(id: number): ModFile {
    return {
        id,
        name: `file-${id}`,
        version: '1.0',
        size: 100,
        type: 'pak',
        download_url: `https://cdn.example.com/${id}.pak`,
        url: null,
        image_id: null,
        desc: null,
        label: null,
        downloads: null,
        created_at: null,
    }
}

function makeLink(id: number): ModLink {
    return {
        id,
        name: `link-${id}`,
        url: `https://example.com/${id}`,
        desc: null,
        label: null,
        version: null,
        image_id: null,
        downloads: null,
        created_at: null,
    }
}

let mockGetMod: ReturnType<typeof vi.fn>
let mockListModFiles: ReturnType<typeof vi.fn>
let mockListModLinks: ReturnType<typeof vi.fn>
let mockListMods: ReturnType<typeof vi.fn>
let storage: ReturnType<typeof makeLocalStorage>
let cache!: typeof ModCacheMod

beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    mockGetMod = vi.fn()
    mockListModFiles = vi.fn()
    mockListModLinks = vi.fn()
    mockListMods = vi.fn()

    vi.doMock('./api', () => ({
        api: {
            getMod: mockGetMod,
            listModFiles: mockListModFiles,
            listModLinks: mockListModLinks,
            listMods: mockListMods,
        },
    }))

    storage = makeLocalStorage()
    vi.stubGlobal('localStorage', storage)

    cache = await import('./modCache')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('getModCacheEntry', () => {
    it('returns undefined for an unknown id', () => {
        expect(cache.getModCacheEntry(1)).toBeUndefined()
    })

    it('returns the entry after a successful getCachedMod', async () => {
        const mod = makeMod(1)
        mockGetMod.mockResolvedValue(mod)
        await cache.getCachedMod(1)
        const entry = cache.getModCacheEntry(1)
        expect(entry).toBeDefined()
        expect(entry!.mod).toBe(mod)
        expect(entry!.fetchedAt).toBe(0)
    })
})

describe('clearModCache', () => {
    it('reports freed bytes and wipes the maps and storage', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        await vi.advanceTimersByTimeAsync(2000)
        expect(cache.getModCacheSize()).toBeGreaterThan(0)

        const freed = cache.clearModCache()
        expect(freed).toBeGreaterThan(0)
        expect(cache.getModCacheSize()).toBe(0)
        expect(cache.getModCacheEntry(1)).toBeUndefined()
        expect(storage.getItem('modrex:mod-cache')).toBeNull()
    })

    it('cancels the pending debounced write so it cannot re-persist', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        cache.clearModCache()
        await vi.advanceTimersByTimeAsync(2000)
        expect(cache.getModCacheSize()).toBe(0)
        expect(storage.getItem('modrex:mod-cache')).toBeNull()
    })
})

describe('getCachedMod', () => {
    it('calls api.getMod on a cache miss', async () => {
        const mod = makeMod(1)
        mockGetMod.mockResolvedValue(mod)
        const result = await cache.getCachedMod(1)
        expect(mockGetMod).toHaveBeenCalledOnce()
        expect(result).toBe(mod)
    })

    it('returns the cached value on a hit without calling api.getMod', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        await cache.getCachedMod(1)
        expect(mockGetMod).toHaveBeenCalledOnce()
    })

    it('re-fetches when the TTL has expired', async () => {
        const mod2 = { ...makeMod(1), name: 'Updated' }
        mockGetMod.mockResolvedValueOnce(makeMod(1)).mockResolvedValueOnce(mod2)
        await cache.getCachedMod(1)
        vi.setSystemTime(new Date(TTL_MS))
        const result = await cache.getCachedMod(1)
        expect(mockGetMod).toHaveBeenCalledTimes(2)
        expect(result).toBe(mod2)
    })

    it('returns the cached value just before the TTL expires', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        vi.setSystemTime(new Date(TTL_MS - 1))
        await cache.getCachedMod(1)
        expect(mockGetMod).toHaveBeenCalledOnce()
    })
})

describe('getCachedModFiles', () => {
    it('calls api.listModFiles on a miss and caches the result', async () => {
        const files = [makeFile(1)]
        mockListModFiles.mockResolvedValue({ data: files })
        expect(await cache.getCachedModFiles(1)).toEqual(files)
        await cache.getCachedModFiles(1)
        expect(mockListModFiles).toHaveBeenCalledOnce()
    })

    it('re-fetches when the TTL has expired', async () => {
        const files2 = [makeFile(2)]
        mockListModFiles
            .mockResolvedValueOnce({ data: [makeFile(1)] })
            .mockResolvedValueOnce({ data: files2 })
        await cache.getCachedModFiles(1)
        vi.setSystemTime(new Date(TTL_MS))
        expect(await cache.getCachedModFiles(1)).toEqual(files2)
        expect(mockListModFiles).toHaveBeenCalledTimes(2)
    })
})

describe('getCachedModLinks', () => {
    it('calls api.listModLinks on a miss and caches the result', async () => {
        const links = [makeLink(1)]
        mockListModLinks.mockResolvedValue({ data: links })
        expect(await cache.getCachedModLinks(1)).toEqual(links)
        await cache.getCachedModLinks(1)
        expect(mockListModLinks).toHaveBeenCalledOnce()
    })

    it('re-fetches when the TTL has expired', async () => {
        const links2 = [makeLink(2)]
        mockListModLinks
            .mockResolvedValueOnce({ data: [makeLink(1)] })
            .mockResolvedValueOnce({ data: links2 })
        await cache.getCachedModLinks(1)
        vi.setSystemTime(new Date(TTL_MS))
        expect(await cache.getCachedModLinks(1)).toEqual(links2)
        expect(mockListModLinks).toHaveBeenCalledTimes(2)
    })
})

describe('loadFromStorage', () => {
    async function importWithStorage() {
        vi.resetModules()
        return (await import('./modCache')) as typeof ModCacheMod
    }

    it('pre-warms the cache with entries younger than the storage TTL', async () => {
        const mod = makeMod(99)
        storage.setItem(STORAGE_KEY, JSON.stringify({ '99': { mod, fetchedAt: 0 } }))
        const freshCache = await importWithStorage()
        expect(freshCache.getModCacheEntry(99)!.mod).toEqual(mod)
    })

    it('skips entries at or past the storage TTL', async () => {
        storage.setItem(STORAGE_KEY, JSON.stringify({ '99': { mod: makeMod(99), fetchedAt: 0 } }))
        vi.setSystemTime(new Date(STORAGE_TTL_MS))
        const freshCache = await importWithStorage()
        expect(freshCache.getModCacheEntry(99)).toBeUndefined()
    })

    it('skips entries stored before the download fields existed', async () => {
        const older: Record<string, unknown> = { ...makeMod(99) }
        delete older.download_id
        delete older.files_are_versions
        delete older.download_type
        storage.setItem(STORAGE_KEY, JSON.stringify({ '99': { mod: older, fetchedAt: 0 } }))
        storage.setItem(
            'modrex:installed-meta-cache',
            JSON.stringify({ '99': { mod: older, fetchedAt: 0 } })
        )
        const freshCache = await importWithStorage()
        expect(freshCache.getModCacheEntry(99)).toBeUndefined()
        expect(freshCache.getInstalledMetaEntry(99)).toBeUndefined()
    })

    it('silently handles corrupt JSON in localStorage', async () => {
        storage.setItem(STORAGE_KEY, 'not valid json')
        const freshCache = await importWithStorage()
        expect(freshCache.getModCacheEntry(1)).toBeUndefined()
    })

    it('starts with an empty cache when the storage key is absent', async () => {
        const freshCache = await importWithStorage()
        expect(freshCache.getModCacheEntry(1)).toBeUndefined()
    })
})

describe('scheduleStorage', () => {
    it('writes to localStorage after the 2s debounce', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        expect(storage.getItem(STORAGE_KEY)).toBeNull()
        vi.advanceTimersByTime(2001)
        const stored = JSON.parse(storage.getItem(STORAGE_KEY)!)
        expect(stored['1']).toBeDefined()
    })

    it('does not write before the debounce period elapses', async () => {
        mockGetMod.mockResolvedValue(makeMod(1))
        await cache.getCachedMod(1)
        vi.advanceTimersByTime(1999)
        expect(storage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('debounces multiple rapid fetches into a single flush cycle', async () => {
        const setItemSpy = vi.spyOn(storage, 'setItem')
        mockGetMod.mockResolvedValueOnce(makeMod(1)).mockResolvedValueOnce(makeMod(2))
        await cache.getCachedMod(1)
        await cache.getCachedMod(2)
        vi.advanceTimersByTime(2001)
        // One flush writes four keys: mod-cache, files-cache, links-cache, installed-meta-cache
        expect(setItemSpy).toHaveBeenCalledTimes(4)
    })
})

describe('fetchInstalledModsMeta', () => {
    it('calls api.listMods with an ids filter on a miss and caches the result', async () => {
        const mod = makeMod(1)
        mockListMods.mockResolvedValue({ data: [mod], meta: {} })
        const { mods, failedIds } = await cache.fetchInstalledModsMeta(853, [1])
        expect(mockListMods).toHaveBeenCalledWith(853, { ids: [1], limit: 1 })
        expect(mods.get(1)).toBe(mod)
        expect(failedIds).toEqual([])
        expect(cache.getInstalledMetaEntry(1)!.mod).toBe(mod)
    })

    it('reports ids missing from the response as failed', async () => {
        mockListMods.mockResolvedValue({ data: [makeMod(1)], meta: {} })
        const { mods, failedIds } = await cache.fetchInstalledModsMeta(853, [1, 2])
        expect(mods.has(2)).toBe(false)
        expect(failedIds).toEqual([2])
    })

    it('reports the whole chunk as failed when the request rejects', async () => {
        mockListMods.mockRejectedValue(new Error('modworkshop API 429'))
        const { mods, failedIds } = await cache.fetchInstalledModsMeta(853, [1, 2])
        expect(mods.size).toBe(0)
        expect(failedIds).toEqual([1, 2])
    })

    it('splits more than 50 ids into multiple chunked requests', async () => {
        mockListMods.mockResolvedValue({ data: [], meta: {} })
        const ids = Array.from({ length: 75 }, (_, i) => i + 1)
        await cache.fetchInstalledModsMeta(853, ids)
        expect(mockListMods).toHaveBeenCalledTimes(2)
        expect(mockListMods).toHaveBeenNthCalledWith(1, 853, { ids: ids.slice(0, 50), limit: 50 })
        expect(mockListMods).toHaveBeenNthCalledWith(2, 853, { ids: ids.slice(50), limit: 25 })
    })

    it('never writes into the modCache used by getCachedMod/ModDetailPage', async () => {
        const mod = makeMod(1)
        mockListMods.mockResolvedValue({ data: [mod], meta: {} })
        await cache.fetchInstalledModsMeta(853, [1])
        expect(cache.getModCacheEntry(1)).toBeUndefined()
    })
})

describe('getInstalledMetaEntry', () => {
    it('returns undefined for an unknown id', () => {
        expect(cache.getInstalledMetaEntry(1)).toBeUndefined()
    })
})

import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { LoaderInfo } from '../../shared/bindings'

// The listing comes from Rust at runtime; stub api.listLoaders with the same shape
// list_loaders returns so the lookups can be tested without the backend. One entry per
// game-to-loader relationship, carrying only the ids that game publishes the loader under.
const REGISTRY: LoaderInfo[] = [
    { id: 'superblt', modworkshopIds: [], games: ['pd2'], viaModFlow: false },
    { id: 'pdth_overrides', modworkshopIds: [53474], games: ['pdth'], viaModFlow: false },
    { id: 'dahm', modworkshopIds: [14267], games: ['pdth'], viaModFlow: false },
    { id: 'raid_superblt', modworkshopIds: [49744], games: ['raid'], viaModFlow: false },
    { id: 'ue4ss', modworkshopIds: [47749], games: ['cb'], viaModFlow: true },
    { id: 'ue4ss', modworkshopIds: [47771, 44048], games: ['pd3'], viaModFlow: true },
]

let mod: typeof import('./loaders')
let mockCheckLoader: ReturnType<typeof vi.fn>

beforeEach(async () => {
    vi.resetModules()
    mockCheckLoader = vi.fn().mockResolvedValue(true)
    vi.doMock('./api', () => ({
        api: {
            listLoaders: vi.fn().mockResolvedValue(REGISTRY),
            checkLoader: mockCheckLoader,
        },
    }))
    mod = await import('./loaders')
    await mod.loadLoaderRegistry()
})

describe('loadersForGame', () => {
    it('returns only the loaders a game uses', () => {
        expect(mod.loadersForGame('pdth').map((l) => l.id)).toEqual(['pdth_overrides', 'dahm'])
        expect(mod.loadersForGame('pd2').map((l) => l.id)).toEqual(['superblt'])
    })

    it('returns a loader shared by several games for each of them', () => {
        expect(mod.loadersForGame('pd3').map((l) => l.id)).toEqual(['ue4ss'])
        expect(mod.loadersForGame('cb').map((l) => l.id)).toEqual(['ue4ss'])
    })

    it('returns nothing for an unknown game', () => {
        expect(mod.loadersForGame('nope')).toEqual([])
    })
})

describe('loaderForModId', () => {
    it('resolves each of the PD3 UE4SS mod pages to the one loader', () => {
        expect(mod.loaderForModId('pd3', 47771)?.id).toBe('ue4ss')
        expect(mod.loaderForModId('pd3', 44048)?.id).toBe('ue4ss')
    })

    it('resolves PDTH loader pages', () => {
        expect(mod.loaderForModId('pdth', 53474)?.id).toBe('pdth_overrides')
        expect(mod.loaderForModId('pdth', 14267)?.id).toBe('dahm')
    })

    it('does not resolve another game UE4SS page', () => {
        expect(mod.loaderForModId('pd3', 47749)).toBeUndefined()
        expect(mod.loaderForModId('cb', 47771)).toBeUndefined()
    })

    it('does not resolve a loader id under a game that does not use it', () => {
        expect(mod.loaderForModId('pd2', 53474)).toBeUndefined()
        expect(mod.loaderForModId('raid', 47771)).toBeUndefined()
    })

    it('returns undefined for an ordinary mod id', () => {
        expect(mod.loaderForModId('pdth', 12345)).toBeUndefined()
    })
})

describe('buildLoaderModIds', () => {
    it('maps PDTH loader pages to their own states', () => {
        expect(mod.buildLoaderModIds('pdth', { pdth_overrides: true, dahm: false })).toEqual({
            53474: true,
            14267: false,
        })
    })

    it('spreads one UE4SS state across every page that distributes it for that game', () => {
        expect(mod.buildLoaderModIds('pd3', { ue4ss: true })).toEqual({
            47771: true,
            44048: true,
        })
        expect(mod.buildLoaderModIds('cb', { ue4ss: true })).toEqual({ 47749: true })
    })

    it('reports an unchecked loader as null rather than omitting it', () => {
        expect(mod.buildLoaderModIds('raid', {})).toEqual({ 49744: null })
    })

    it('returns empty for a game whose only loader has no mod page', () => {
        expect(mod.buildLoaderModIds('pd2', { superblt: true })).toEqual({})
    })
})

describe('resolveLoaderState', () => {
    it('checks only loaders the mod actually depends on', async () => {
        const state = await mod.resolveLoaderState('pdth', '/game', [53474], {})
        expect(mockCheckLoader).toHaveBeenCalledTimes(1)
        expect(mockCheckLoader).toHaveBeenCalledWith('pdth_overrides', 'pdth', '/game')
        expect(state).toEqual({ pdth_overrides: true })
    })

    it('keeps an already-known state instead of re-checking it', async () => {
        const state = await mod.resolveLoaderState('pdth', '/game', [53474], {
            pdth_overrides: false,
        })
        expect(mockCheckLoader).not.toHaveBeenCalled()
        expect(state).toEqual({ pdth_overrides: false })
    })

    it('checks nothing when no dependency names a loader', async () => {
        await mod.resolveLoaderState('pdth', '/game', [999], {})
        expect(mockCheckLoader).not.toHaveBeenCalled()
    })
})

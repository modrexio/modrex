import { describe, expect, it } from 'vitest'
import type { LoaderInfo } from '../api'
import type { InstalledMod, ModFolder } from '../../../shared/types'
import {
    GAME_FILES_TAB,
    activeTabKey,
    filesOnOtherTabs,
    foldersHoldingMods,
    installedTabKey,
    needsAttention,
    orderedTabKeys,
} from './installedTabs'

function makeMod(overrides: Partial<InstalledMod> = {}): InstalledMod {
    return {
        uid: 'mod-file',
        id: -100,
        name: 'Mod',
        version: '1',
        filename: 'Mod',
        enabled: true,
        installedAt: '',
        ...overrides,
    }
}

const loaders: LoaderInfo[] = [
    { id: 'superblt', target: null, modworkshopIds: [], games: ['pd2'], viaModFlow: false },
    {
        id: 'ue4ss',
        target: 'ue4ss_mods',
        modworkshopIds: [47771],
        games: ['pd3'],
        viaModFlow: true,
    },
]

describe('installedTabKey', () => {
    it('uses the supplied primary tag when location is absent', () => {
        expect(installedTabKey(makeMod(), [], 'mods', loaders)).toBe('mods')
        expect(installedTabKey(makeMod(), [], 'paks', loaders)).toBe('paks')
    })

    it.each(['mods', 'mod_overrides', 'ue4ss_mods', 'paks'])(
        'keeps the explicit target tag %s',
        (location) => {
            expect(installedTabKey(makeMod({ location }), [], 'mods', loaders)).toBe(location)
        }
    )

    it('puts a primary-target loader in the primary tab', () => {
        const mod = makeMod({ location: 'loader:superblt' })
        expect(installedTabKey(mod, [], 'mods', loaders)).toBe('mods')
    })

    it('reads the secondary loader target from the registry', () => {
        const mod = makeMod({ location: 'loader:ue4ss' })
        expect(installedTabKey(mod, [], 'paks', loaders)).toBe('ue4ss_mods')
        const registry = [{ ...loaders[1], target: 'custom_target' }]
        expect(installedTabKey(mod, [], 'paks', registry)).toBe('custom_target')
    })

    it('uses the primary target for an unavailable loader entry', () => {
        const mod = makeMod({ location: 'loader:unknown' })
        expect(installedTabKey(mod, [], 'mods', loaders)).toBe('mods')
    })

    it('matches the host by its remote ID rather than the local record ID', () => {
        const pack = makeMod({ location: 'host:17160:Assets/Themes' })
        const wrongHost = makeMod({ id: 17160, remoteId: '999', location: 'paks' })
        const host = makeMod({ id: -54321, source: 'modworkshop', remoteId: '17160' })
        expect(installedTabKey(pack, [wrongHost, host, pack], 'mods', loaders)).toBe('mods')
    })

    it.each([undefined, 'modworkshop'])(
        'inherits a secondary host target with source %s',
        (source) => {
            const pack = makeMod({ location: 'host:17160:Assets' })
            const host = makeMod({ source, remoteId: '17160', location: 'mod_overrides' })
            expect(installedTabKey(pack, [host, pack], 'mods', loaders)).toBe('mod_overrides')
        }
    )

    it('resolves a host loader through the loader registry', () => {
        const pack = makeMod({ location: 'host:17160:Assets' })
        const host = makeMod({ remoteId: '17160', location: 'loader:ue4ss' })
        expect(installedTabKey(pack, [host, pack], 'paks', loaders)).toBe('ue4ss_mods')
    })

    it('uses the primary tab when the host is absent', () => {
        const pack = makeMod({ location: 'host:17160:Assets' })
        expect(installedTabKey(pack, [pack], 'mods', loaders)).toBe('mods')
    })

    it('does not match another source or a host pack with the same remote ID', () => {
        const pack = makeMod({ remoteId: '17160', location: 'host:17160:Assets' })
        const nexus = makeMod({ source: 'nexus', remoteId: '17160', location: 'paks' })
        expect(installedTabKey(pack, [nexus, pack], 'mods', loaders)).toBe('mods')
    })

    it.each(['movie', 'ini'] as const)(
        'puts %s deployments before location routing',
        (deployment) => {
            for (const location of [undefined, 'paks', 'loader:ue4ss', 'host:17160:Assets']) {
                const mod = makeMod({ deployment, location })
                expect(installedTabKey(mod, [], 'mods', loaders)).toBe(GAME_FILES_TAB)
            }
        }
    )
})

describe('orderedTabKeys', () => {
    it('orders nonempty targets by the supplied game target order with game files last', () => {
        expect(
            orderedTabKeys(
                ['mods', 'mod_overrides', 'ue4ss_mods'],
                [GAME_FILES_TAB, 'ue4ss_mods', 'mods', 'ue4ss_mods']
            )
        ).toEqual(['mods', 'ue4ss_mods', GAME_FILES_TAB])
    })

    it('accepts a set and excludes keys outside the game targets', () => {
        expect(orderedTabKeys(['mods', 'paks', 'x'], new Set(['paks', 'x', 'unknown']))).toEqual([
            'mods',
            'paks',
            'x',
        ])
    })

    it('shows no tabs while fewer than two locations hold mods', () => {
        expect(orderedTabKeys(['mods', 'paks'], [])).toEqual([])
        expect(orderedTabKeys(['mods', 'paks'], ['mods'])).toEqual([])
        expect(orderedTabKeys(['mods', 'paks'], ['paks'])).toEqual([])
        expect(orderedTabKeys(['mods'], [GAME_FILES_TAB])).toEqual([])
    })

    it('always includes the primary target once tabs show', () => {
        expect(orderedTabKeys(['mods', 'paks', 'ue4ss_mods'], ['paks', 'ue4ss_mods'])).toEqual([
            'mods',
            'paks',
            'ue4ss_mods',
        ])
        expect(orderedTabKeys(['paks', 'ue4ss_mods'], ['ue4ss_mods', GAME_FILES_TAB])).toEqual([
            'paks',
            'ue4ss_mods',
            GAME_FILES_TAB,
        ])
    })
})

describe('activeTabKey', () => {
    it('is null without tabs', () => {
        expect(activeTabKey([], 'mods')).toBeNull()
    })

    it('keeps the remembered tab while it is shown', () => {
        expect(activeTabKey(['mods', 'paks'], 'paks')).toBe('paks')
    })

    it('falls back to the first tab for a missing or absent remembered tab', () => {
        expect(activeTabKey(['mods', 'paks'], 'ue4ss_mods')).toBe('mods')
        expect(activeTabKey(['mods', 'paks'], null)).toBe('mods')
    })
})

describe('needsAttention', () => {
    it.each([
        { missing: true },
        { containerMissing: true },
        { archiveBroken: true },
        { resourceStatus: 'diverged' as const },
        { resourceStatus: 'blocked' as const },
    ])('flags %o', (overrides) => {
        expect(needsAttention(makeMod(overrides))).toBe(true)
    })

    it('leaves a healthy mod alone', () => {
        expect(needsAttention(makeMod())).toBe(false)
    })
})

describe('foldersHoldingMods', () => {
    function makeFolder(id: string, parentId: string | null): ModFolder {
        return { id, displayName: id, diskName: id, parentId, priority: 0 }
    }
    const folders = [
        makeFolder('a', null),
        makeFolder('a1', 'a'),
        makeFolder('a1x', 'a1'),
        makeFolder('b', null),
        makeFolder('c', null),
    ]

    it('returns each holding folder with its ancestors in folder order', () => {
        const mods = [makeMod({ folderId: 'a1x' }), makeMod({ folderId: 'c' })]
        expect(foldersHoldingMods(mods, folders).map((f) => f.id)).toEqual(['a', 'a1', 'a1x', 'c'])
    })

    it('returns no folders for root mods', () => {
        expect(foldersHoldingMods([makeMod()], folders)).toEqual([])
    })
})

describe('filesOnOtherTabs', () => {
    const pak = makeMod({ uid: 'pak', id: 7 })
    const lua = makeMod({ uid: 'lua', id: 7, location: 'ue4ss_mods' })
    const movie = makeMod({ uid: 'movie', id: 7, deployment: 'movie' })
    const loader = makeMod({ uid: 'loader', id: 7, location: 'loader:ue4ss' })
    const other = makeMod({ uid: 'other', id: 8, location: 'ue4ss_mods' })
    const installed = [pak, lua, movie, loader, other]
    const tabOf = new Map([
        ['pak', 'paks'],
        ['lua', 'ue4ss_mods'],
        ['movie', GAME_FILES_TAB],
        ['loader', 'ue4ss_mods'],
        ['other', 'ue4ss_mods'],
    ])

    it('collects the same mod on other tabs, without resources or loaders', () => {
        const byId = filesOnOtherTabs(installed, tabOf, 'paks')
        expect(byId.get(7)).toEqual({ files: [lua], tabKeys: ['ue4ss_mods'] })
    })

    it('leaves out the files on the active tab', () => {
        const byId = filesOnOtherTabs(installed, tabOf, 'ue4ss_mods')
        expect(byId.get(7)).toEqual({ files: [pak], tabKeys: ['paks'] })
        expect(byId.has(8)).toBe(false)
    })
})

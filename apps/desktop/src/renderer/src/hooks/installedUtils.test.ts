import { describe, it, expect } from 'vitest'
import type { InstalledMod, ModFolder } from '../../../shared/types'
import {
    displayFilename,
    entryFilename,
    stripPriorityPrefix,
    syntheticMod,
    getAllModsInFolder,
    filterInstalled,
    normalizeModScopes,
    foldersEmptiedByNormalize,
    computeChildren,
    groupChildren,
    findSuspectDuplicateGroups,
    resolveStaleDuplicates,
    groupInstalledByIdentity,
    computeHealthSummary,
    hasCatalogLink,
    isIdentified,
    withDeclaredMetadata,
    detailNavArgs,
    type ChildEntry,
    type ChildGroup,
} from './installedUtils'

function catalogIdentity(remoteId: string, source = 'modworkshop'): Partial<InstalledMod> {
    return {
        remoteId,
        source,
        identity: {
            namespace: source,
            key: remoteId,
            confidence: 'exact',
            evidence: 'installProvenance',
        },
    }
}

function localIdentity(namespace: string, key: string): Partial<InstalledMod> {
    return {
        identity: { namespace, key, confidence: 'strong', evidence: 'updaterNamespace' },
    }
}

function candidateIdentity(key: string): Partial<InstalledMod> {
    return {
        identity: { namespace: 'local', key, confidence: 'candidate', evidence: 'nameAuthor' },
    }
}

function makeMod(
    uid: string,
    id: number,
    name: string,
    overrides: Partial<InstalledMod> = {}
): InstalledMod {
    return {
        uid,
        id,
        name,
        version: '1.0',
        filename: `${uid}.pak`,
        enabled: true,
        installedAt: '2024-01-01T00:00:00Z',
        folderId: null,
        priority: 0,
        // A positive id in these fixtures has always meant "modworkshop-identified".
        // That is now two facts: a catalog reference (remoteId) and the identity resolved
        // from it, which is how a real catalog install looks after get_installed runs.
        ...(id >= 0 ? catalogIdentity(String(id)) : {}),
        ...overrides,
    }
}

function makeFolder(id: string, overrides: Partial<ModFolder> = {}): ModFolder {
    return {
        id,
        diskName: id,
        displayName: id,
        priority: 0,
        parentId: null,
        ...overrides,
    }
}

describe('stripPriorityPrefix', () => {
    it('strips the NNN_ prefix and keeps the extension', () => {
        expect(stripPriorityPrefix('001_zDarkMatter_AG-9.pak')).toBe('zDarkMatter_AG-9.pak')
    })

    it('leaves unprefixed names intact', () => {
        expect(stripPriorityPrefix('zDarkMatter_AG-9.pak')).toBe('zDarkMatter_AG-9.pak')
    })
})

describe('entryFilename', () => {
    it('returns the last path component', () => {
        expect(entryFilename('DarkMatterSkins/zDarkMatter_AG-9.pak')).toBe('zDarkMatter_AG-9.pak')
    })

    it('returns the entry itself when there is no directory', () => {
        expect(entryFilename('mod.pak')).toBe('mod.pak')
    })
})

describe('displayFilename', () => {
    it('strips the priority prefix and .pak extension', () => {
        expect(displayFilename('001_zDarkMatter_AG-9.pak')).toBe('zDarkMatter_AG-9')
    })

    it('strips only the extension when there is no prefix', () => {
        expect(displayFilename('CoolMod.pak')).toBe('CoolMod')
    })

    it('strips the extension case-insensitively', () => {
        expect(displayFilename('059_Skins.PAK')).toBe('Skins')
    })

    it('leaves directory-unit names (no extension) intact apart from the prefix', () => {
        expect(displayFilename('SuperBLT Mod')).toBe('SuperBLT Mod')
    })

    it('does not strip digits that are part of the name', () => {
        expect(displayFilename('AG9_Skin.pak')).toBe('AG9_Skin')
    })

    it('falls back to the raw name when stripping empties it', () => {
        expect(displayFilename('001_.pak')).toBe('001_.pak')
    })
})

describe('detailNavArgs', () => {
    it('returns the plain id and no source for a modworkshop mod', () => {
        const mod = makeMod('u1', 42, 'Some Mod')
        expect(detailNavArgs(mod)).toEqual([42, undefined])
    })

    it('resolves the real positive Nexus mod id and the nexus source', () => {
        const mod = makeMod('u1', -216, 'Unmask Mod', { source: 'nexus', remoteId: '216' })
        expect(detailNavArgs(mod)).toEqual([216, 'nexus'])
    })

    it('falls back to the installed id when remoteId is missing or unusable', () => {
        const mod = makeMod('u1', -216, 'Unmask Mod', { source: 'nexus' })
        expect(detailNavArgs(mod)).toEqual([-216, undefined])
    })
})

describe('syntheticMod', () => {
    it('maps id, name, and version from the installed mod', () => {
        const ins = makeMod('uid1', 42, 'Cool Mod', { version: '2.5' })
        const result = syntheticMod(ins)
        expect(result.id).toBe(42)
        expect(result.name).toBe('Cool Mod')
        expect(result.version).toBe('2.5')
    })

    it('sets fixed fallback values for all remote-only fields', () => {
        const ins = makeMod('uid1', 1, 'Mod')
        const result = syntheticMod(ins)
        expect(result.desc).toBe('')
        expect(result.short_desc).toBe('Manually installed — not on ModWorkshop')
        expect(result.downloads).toBe(0)
        expect(result.likes).toBe(0)
        expect(result.views).toBe(0)
        expect(result.has_download).toBe(false)
        expect(result.thumbnail).toBeNull()
        expect(result.download).toBeNull()
        expect(result.user).toEqual({
            id: null,
            name: 'Unknown',
            donation_url: null,
            avatar: null,
            avatar_has_thumb: null,
        })
    })

    it('uses installedAt for both published_at and bumped_at', () => {
        const ins = makeMod('uid1', 1, 'Mod', { installedAt: '2025-06-01T12:00:00Z' })
        const result = syntheticMod(ins)
        expect(result.published_at).toBe('2025-06-01T12:00:00Z')
        expect(result.bumped_at).toBe('2025-06-01T12:00:00Z')
    })
})

describe('getAllModsInFolder', () => {
    it('returns direct mods in the folder', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f1' }),
            makeMod('c', 3, 'C', { folderId: null }),
        ]
        const result = getAllModsInFolder(mods, [], 'f1')
        expect(result).toHaveLength(2)
        expect(result.map((m) => m.uid)).toEqual(expect.arrayContaining(['a', 'b']))
    })

    it('recursively includes mods in nested subfolders', () => {
        const folders = [makeFolder('f1'), makeFolder('f2', { parentId: 'f1' })]
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f2' }),
        ]
        const result = getAllModsInFolder(mods, folders, 'f1')
        expect(result.map((m) => m.uid)).toEqual(expect.arrayContaining(['a', 'b']))
    })

    it('returns empty array for a folder that has no mods', () => {
        const folders = [makeFolder('f1')]
        expect(getAllModsInFolder([], folders, 'f1')).toEqual([])
    })

    it('does not include mods from sibling folders', () => {
        const mods = [makeMod('a', 1, 'A', { folderId: 'f2' })]
        const result = getAllModsInFolder(mods, [makeFolder('f2')], 'f1')
        expect(result).toEqual([])
    })

    it('does not include root-level mods when querying a specific folder', () => {
        const mods = [makeMod('a', 1, 'A', { folderId: null })]
        expect(getAllModsInFolder(mods, [], 'f1')).toEqual([])
    })
})

describe('filterInstalled', () => {
    const folders = [makeFolder('parent'), makeFolder('child', { parentId: 'parent' })]
    const mods = [
        makeMod('a', 1, 'Crimson Heist', { folderId: 'child' }),
        makeMod('b', 2, 'Blue Storm', { folderId: null }),
        makeMod('c', 3, 'Alpha Mod', { folderId: null }),
    ]

    it('returns mods matching query case-insensitively', () => {
        const { mods: result } = filterInstalled(mods, folders, 'crimson')
        expect(result).toHaveLength(1)
        expect(result[0].uid).toBe('a')
    })

    it('matches substring anywhere in the name', () => {
        // 'e' appears in 'Crimson H[e]ist' and 'Blu[e] Storm' but not 'Alpha Mod'
        const { mods: result } = filterInstalled(mods, folders, 'e')
        expect(result.map((m) => m.uid)).toEqual(expect.arrayContaining(['a', 'b']))
        expect(result).toHaveLength(2)
    })

    it('returns all mods when query is empty', () => {
        const { mods: result } = filterInstalled(mods, folders, '')
        expect(result).toHaveLength(3)
    })

    it('returns empty array when no mods match', () => {
        const { mods: result } = filterInstalled(mods, folders, 'zzzzz')
        expect(result).toHaveLength(0)
    })

    it('includes all ancestor folder IDs of matching mods', () => {
        const { visibleFolderIds } = filterInstalled(mods, folders, 'crimson')
        expect(visibleFolderIds.has('child')).toBe(true)
        expect(visibleFolderIds.has('parent')).toBe(true)
    })

    it('root-level mods add no folder IDs to visibleFolderIds', () => {
        const { visibleFolderIds } = filterInstalled(mods, folders, 'Blue Storm')
        expect(visibleFolderIds.size).toBe(0)
    })

    it('returns an empty visibleFolderIds when no mods match', () => {
        const { visibleFolderIds } = filterInstalled(mods, folders, 'zzzzz')
        expect(visibleFolderIds.size).toBe(0)
    })
})

describe('normalizeModScopes', () => {
    it('returns the same array reference when all mods have unique IDs', () => {
        const mods = [makeMod('a', 1, 'A'), makeMod('b', 2, 'B')]
        expect(normalizeModScopes(mods)).toBe(mods)
    })

    it('returns the same array reference when all copies of an ID share the same scope', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 1, 'B', { folderId: 'f1' }),
        ]
        expect(normalizeModScopes(mods)).toBe(mods)
    })

    it('root (null) scope wins over any folder scope', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: null }),
            makeMod('b', 1, 'B', { folderId: 'f1' }),
        ]
        const result = normalizeModScopes(mods)
        expect(result.find((m) => m.uid === 'a')!.folderId ?? null).toBeNull()
        expect(result.find((m) => m.uid === 'b')!.folderId ?? null).toBeNull()
    })

    it('does not normalize entries spread across non-root folders', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 1, 'B', { folderId: 'f1' }),
            makeMod('c', 1, 'C', { folderId: 'f2' }),
        ]
        expect(normalizeModScopes(mods)).toBe(mods)
    })

    it('does not affect mods with negative IDs', () => {
        const mods = [
            makeMod('a', -1, 'A', { folderId: 'f1' }),
            makeMod('b', -1, 'B', { folderId: 'f2' }),
        ]
        expect(normalizeModScopes(mods)).toBe(mods)
    })

    it('does not alter mods whose IDs are not in conflict', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f2' }),
            makeMod('c', 1, 'C', { folderId: 'f2' }),
        ]
        const result = normalizeModScopes(mods)
        expect(result.find((m) => m.uid === 'b')!.folderId).toBe('f2')
    })
})

describe('foldersEmptiedByNormalize', () => {
    const folder = (id: string, parentId: string | null = null): ModFolder => ({
        id,
        diskName: id,
        displayName: id,
        priority: 1,
        parentId,
    })

    it('hides a folder whose only mod was pulled to root', () => {
        // Real shape (Dark Matter Skins): a multi-pak archive in a folder plus a separate
        // required bare pak at root, so normalize collapses the group to root and the folder
        // would otherwise render as an empty duplicate next to the mod's card.
        const raw = [
            makeMod('100_a', 1, 'A', { folderId: 'f1' }),
            makeMod('100_b', 1, 'B', { folderId: 'f1' }),
            makeMod('200', 1, 'C', { folderId: null }),
        ]
        const normalized = normalizeModScopes(raw)
        const emptied = foldersEmptiedByNormalize(raw, normalized, [folder('f1')])
        expect(emptied).toEqual(new Set(['f1']))
    })

    it('keeps folders that were already empty before normalization', () => {
        const raw = [makeMod('a', 1, 'A', { folderId: null })]
        const emptied = foldersEmptiedByNormalize(raw, raw, [folder('f1')])
        expect(emptied.size).toBe(0)
    })

    it('keeps a parent whose subtree still has mods in another child folder', () => {
        const folders = [folder('f1'), folder('f2', 'f1')]
        const raw = [
            makeMod('100_a', 1, 'A', { folderId: 'f1' }),
            makeMod('200', 1, 'B', { folderId: null }),
            makeMod('x', 2, 'X', { folderId: 'f2' }),
        ]
        const normalized = normalizeModScopes(raw)
        const emptied = foldersEmptiedByNormalize(raw, normalized, folders)
        expect(emptied.size).toBe(0)
    })
})

describe('groupInstalledByIdentity', () => {
    it('collapses multi-file mods sharing one positive id into one group', () => {
        const mods = [makeMod('a', 5, 'Mod'), makeMod('b', 5, 'Mod'), makeMod('c', 5, 'Mod')]
        const groups = groupInstalledByIdentity(mods)
        expect(groups).toHaveLength(1)
        expect(groups[0]).toEqual({ key: 'identity:modworkshop:5', id: 5, mods })
    })

    it('keeps negative-id mods in separate groups keyed by uid', () => {
        const mods = [makeMod('a', -1, 'A'), makeMod('b', -1, 'B')]
        const groups = groupInstalledByIdentity(mods)
        expect(groups).toHaveLength(2)
        expect(groups.map((g) => g.key).sort()).toEqual(['uid:a', 'uid:b'])
    })

    it('keeps distinct positive ids in separate groups', () => {
        const mods = [makeMod('a', 1, 'A'), makeMod('b', 2, 'B')]
        expect(groupInstalledByIdentity(mods)).toHaveLength(2)
    })

    it('groups a locally identified mod by its project identity', () => {
        const identity = localIdentity('pd2mods.z77.fr', 'Keepers')
        const mods = [
            makeMod('Keepers', -1, 'Keepers', identity),
            makeMod('Keepers copy', -2, 'Keepers', identity),
        ]
        const groups = groupInstalledByIdentity(mods)
        expect(groups).toHaveLength(1)
        expect(groups[0].key).toBe('identity:pd2mods.z77.fr:Keepers')
    })

    it('keeps unidentified mods separate rather than lumping them together', () => {
        const mods = [makeMod('a', -1, 'A'), makeMod('b', -2, 'B')]
        expect(groupInstalledByIdentity(mods)).toHaveLength(2)
    })
})

describe('isIdentified / hasCatalogLink', () => {
    // The architectural invariant: knowing what a mod is and having somewhere to fetch it
    // from are separate questions, and a mod can answer either one without the other.
    it('identifies a mod from its own metadata with no catalog reference at all', () => {
        const m = makeMod('Celer', -64991831, 'Celer', localIdentity('pd2mods.z77.fr', 'Celer'))
        expect(m.remoteId).toBeUndefined()
        expect(isIdentified(m)).toBe(true)
        expect(hasCatalogLink(m)).toBe(false)
    })

    it('reports a catalog link only when there really is one', () => {
        const m = makeMod('x', 25629, 'VanillaHUD Plus')
        expect(isIdentified(m)).toBe(true)
        expect(hasCatalogLink(m)).toBe(true)
    })

    it('treats a candidate guess as not identified', () => {
        const m = makeMod('x', -1, 'X', candidateIdentity('X@a'))
        expect(isIdentified(m)).toBe(false)
    })

    it('groups by the namespace and key together, never by key alone', () => {
        const updater = makeMod('a', -1, 'Celer', localIdentity('pd2mods.z77.fr', 'Celer'))
        const legacy = makeMod('b', -2, 'Celer', localIdentity('paydaymods', 'Celer'))
        expect(groupInstalledByIdentity([updater, legacy])).toHaveLength(2)
    })

    it('does not call a mod identified just because state carries a remote id', () => {
        // A pre-identity state file, before get_installed has resolved anything.
        const m = makeMod('x', -1, 'X', { remoteId: '999' })
        expect(hasCatalogLink(m)).toBe(true)
        expect(isIdentified(m)).toBe(false)
    })
})

describe('withDeclaredMetadata', () => {
    const declared = { name: 'Celer', author: 'TdlQ', version: '55' }

    it('shows what a mod with no catalog entry says about itself', () => {
        // The folder is the only name such a mod had before, and for a GitHub source archive
        // that is the repository plus branch, not a title anyone chose.
        const m = makeMod('x', -1, 'PD2-Celer-main', {
            ...localIdentity('pd2mods.z77.fr', 'Celer'),
            version: '',
            declared,
        })
        const shown = withDeclaredMetadata(m)
        expect(shown.name).toBe('Celer')
        expect(shown.author).toBe('TdlQ')
        expect(shown.version).toBe('55')
        expect(syntheticMod(shown).user.name).toBe('TdlQ')
    })

    it('leaves a catalog-backed mod on its catalog presentation', () => {
        const m = makeMod('x', 25629, 'VanillaHUD Plus', { declared })
        expect(withDeclaredMetadata(m)).toBe(m)
    })

    it('keeps the tracked values when the mod declares nothing', () => {
        const m = makeMod('x', -1, 'Some Folder', { version: '' })
        expect(withDeclaredMetadata(m)).toBe(m)
    })
})

describe('computeHealthSummary', () => {
    it('flags a group as missing when any of its files is missing', () => {
        const mods = [makeMod('a', 1, 'A', { missing: true }), makeMod('b', 1, 'A')]
        const summary = computeHealthSummary(mods)
        expect(summary.missing).toHaveLength(1)
        expect(summary.missing[0].id).toBe(1)
    })

    it('flags a group as archiveBroken when any of its files is broken', () => {
        const mods = [makeMod('a', 1, 'A', { archiveBroken: true })]
        expect(computeHealthSummary(mods).archiveBroken).toHaveLength(1)
    })

    it('flags a mod with no resolved identity as unidentified', () => {
        const mods = [makeMod('a', -1, 'A'), makeMod('b', 2, 'B', catalogIdentity('2'))]
        const summary = computeHealthSummary(mods)
        expect(summary.unidentified).toHaveLength(1)
        expect(summary.unidentified[0].id).toBe(-1)
    })

    it('does not flag a locally identified mod that has no catalog entry', () => {
        // The conceptual fix: this mod is published only on its author's own updater, so no
        // catalog will ever match it, and Modrex still knows exactly what it is.
        const mods = [
            makeMod('Celer', -64991831, 'Celer', localIdentity('pd2mods.z77.fr', 'Celer')),
        ]
        expect(computeHealthSummary(mods).unidentified).toEqual([])
    })

    it('still flags a candidate-only guess as unidentified', () => {
        const mods = [makeMod('x', -2, 'X', candidateIdentity('X@someone'))]
        expect(computeHealthSummary(mods).unidentified).toHaveLength(1)
    })

    it('does not flag a Nexus-installed mod as unidentified', () => {
        const mods = [
            makeMod('nexus:123:456', -123, 'Nexus Mod', {
                source: 'nexus',
                remoteId: '123',
                ...catalogIdentity('123', 'nexus'),
            }),
        ]
        expect(computeHealthSummary(mods).unidentified).toEqual([])
    })

    it('flags positive-id groups as outdated when any file is marked outdated', () => {
        const mods = [makeMod('a', 1, 'A', { updateStatus: 'outdated', remoteId: '1' })]
        const summary = computeHealthSummary(mods)
        expect(summary.outdated).toHaveLength(1)
        expect(summary.outdated[0].id).toBe(1)
    })

    it('does not flag a mod without a catalog entry as outdated', () => {
        // Outdated means "the catalog has something newer", which is unanswerable without one.
        const mods = [
            makeMod('a', -1, 'A', {
                updateStatus: 'outdated',
                ...localIdentity('pd2mods.z77.fr', 'Celer'),
            }),
        ]
        expect(computeHealthSummary(mods).outdated).toEqual([])
    })

    it('flags groups with a stale duplicate (bare-uid + archive-scheme uid for same fileId)', () => {
        const mods = [
            makeMod('81999', 5, 'Real Weapon Names', { fileId: 81999 }),
            makeMod('81999_zRealWeaponNames_P', 5, 'Real Weapon Names', { fileId: 81999 }),
        ]
        const summary = computeHealthSummary(mods)
        expect(summary.outdated).toHaveLength(1)
        expect(summary.outdated[0].id).toBe(5)
    })

    it('returns empty categories for a clean pack', () => {
        const mods = [makeMod('a', 1, 'A', { enabled: true })]
        const summary = computeHealthSummary(mods)
        expect(summary.missing).toEqual([])
        expect(summary.archiveBroken).toEqual([])
        expect(summary.outdated).toEqual([])
        expect(summary.unidentified).toEqual([])
    })
})

describe('findSuspectDuplicateGroups', () => {
    it('flags a bare-uid entry coexisting with an archive-scheme entry for the same fileId', () => {
        // Real Weapon Names shape: install_mod's bare uid, then install_from_zip_entry's
        // "{fileId}_{stem}" uid for the same fileId after the file's packaging changed.
        const mods = [
            makeMod('81999', 5, 'Mod', { fileId: 81999 }),
            makeMod('81999_zRealWeaponNames_P', 5, 'Mod', { fileId: 81999 }),
        ]
        const suspects = findSuspectDuplicateGroups(mods)
        expect(suspects).toEqual([
            { fileId: 81999, bareUid: '81999', archiveUids: ['81999_zRealWeaponNames_P'] },
        ])
    })

    it('does not flag multiple distinct files under one mod id (Custom FOV shape)', () => {
        // Each file is its own standalone .pak with a different fileId, never a duplicate.
        const mods = [
            makeMod('93530', 55702, 'FOV', { fileId: 93530 }),
            makeMod('93537', 55702, 'FOV', { fileId: 93537 }),
            makeMod('93536', 55702, 'FOV', { fileId: 93536 }),
            makeMod('93533', 55702, 'FOV', { fileId: 93533 }),
        ]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('does not flag several wanted variants extracted from one multi-pak archive', () => {
        // All entries share the archive's fileId but use the archive-scheme uid, no bare uid.
        const mods = [
            makeMod('12345_FOV_100', 9, 'Mod', { fileId: 12345 }),
            makeMod('12345_FOV_120', 9, 'Mod', { fileId: 12345 }),
            makeMod('12345_FOV_140', 9, 'Mod', { fileId: 12345 }),
        ]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('does not flag ambient multi-pak discovery (filename-uid fallback sibling)', () => {
        // mod.rs:620-630: first untracked pak matching a fileId gets the bare uid, the rest get
        // a filename-based uid that never collides with the "{fileId}_" archive-scheme prefix.
        const mods = [
            makeMod('81999', 5, 'Mod', { fileId: 81999 }),
            makeMod('OtherBundledPak.pak', 5, 'Mod', { fileId: 81999 }),
        ]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('bundles multiple archive-scheme siblings into one suspect entry', () => {
        const mods = [
            makeMod('81999', 5, 'Mod', { fileId: 81999 }),
            makeMod('81999_a', 5, 'Mod', { fileId: 81999 }),
            makeMod('81999_b', 5, 'Mod', { fileId: 81999 }),
        ]
        const suspects = findSuspectDuplicateGroups(mods)
        expect(suspects).toHaveLength(1)
        expect(suspects[0].archiveUids.sort()).toEqual(['81999_a', '81999_b'])
    })

    it('ignores a single entry', () => {
        const mods = [makeMod('81999', 5, 'Mod', { fileId: 81999 })]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('ignores entries with no fileId', () => {
        const mods = [makeMod('a', 5, 'Mod'), makeMod('b', 5, 'Mod')]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('ignores negative-id (unrecognized) mods', () => {
        const mods = [
            makeMod('81999', -1, 'Mod', { fileId: 81999 }),
            makeMod('81999_x', -1, 'Mod', { fileId: 81999 }),
        ]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })

    it('ignores entries with a location tag (host packs, secondary targets)', () => {
        const mods = [
            makeMod('81999', 5, 'Mod', { fileId: 81999, location: 'host:1:Assets' }),
            makeMod('81999_x', 5, 'Mod', { fileId: 81999, location: 'host:1:Assets' }),
        ]
        expect(findSuspectDuplicateGroups(mods)).toEqual([])
    })
})

describe('resolveStaleDuplicates', () => {
    const suspect = { fileId: 81999, bareUid: '81999', archiveUids: ['81999_stem'] }

    it('flags the bare uid when the live file is currently an archive type', () => {
        const stale = resolveStaleDuplicates([suspect], [{ id: 81999, type: '7z' }])
        expect(stale).toEqual(new Set(['81999']))
    })

    it('flags the archive uids when the live file is currently a bare pak', () => {
        const stale = resolveStaleDuplicates([suspect], [{ id: 81999, type: 'pak' }])
        expect(stale).toEqual(new Set(['81999_stem']))
    })

    it('flags nothing when the fileId no longer exists in the live file list', () => {
        const stale = resolveStaleDuplicates([suspect], [{ id: 99999, type: 'pak' }])
        expect(stale.size).toBe(0)
    })

    it('flags nothing when given no suspects', () => {
        expect(resolveStaleDuplicates([], [{ id: 81999, type: '7z' }]).size).toBe(0)
    })
})

describe('computeChildren', () => {
    type ModEntry = Extract<ChildEntry, { type: 'mod' }>

    it('places all mod groups before all folders', () => {
        const folders = [makeFolder('f1', { priority: 100 })]
        const mods = [
            makeMod('a', 1, 'A', { priority: 10 }),
            makeMod('b', 2, 'B', { folderId: 'f1' }),
        ]
        const result = computeChildren(mods, folders, null)
        const types = result.map((e) => e.type)
        const lastModIdx = types.lastIndexOf('mod')
        const firstFolderIdx = types.indexOf('folder')
        expect(lastModIdx).toBeLessThan(firstFolderIdx)
    })

    it('groups mods with the same id into a single entry', () => {
        const mods = [
            makeMod('a', 5, 'Mod', { priority: 10 }),
            makeMod('b', 5, 'Mod', { priority: 20 }),
            makeMod('c', 5, 'Mod', { priority: 30 }),
        ]
        const result = computeChildren(mods, [], null)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe('mod')
        expect((result[0] as ModEntry).mods).toHaveLength(3)
    })

    it('sorts mods within a group by priority descending', () => {
        const mods = [
            makeMod('a', 5, 'Mod', { priority: 10 }),
            makeMod('b', 5, 'Mod', { priority: 30 }),
            makeMod('c', 5, 'Mod', { priority: 20 }),
        ]
        const result = computeChildren(mods, [], null)
        expect(result[0].type).toBe('mod')
        expect((result[0] as ModEntry).mods.map((m) => m.priority)).toEqual([30, 20, 10])
    })

    it('sorts independent mod groups by priority descending', () => {
        const mods = [
            makeMod('a', 1, 'A', { priority: 10 }),
            makeMod('b', 2, 'B', { priority: 30 }),
        ]
        const result = computeChildren(mods, [], null)
        expect(result[0].type).toBe('mod')
        expect(result[1].type).toBe('mod')
        expect((result[0] as ModEntry).mods[0].uid).toBe('b')
        expect((result[1] as ModEntry).mods[0].uid).toBe('a')
    })

    it('sorts folders by priority descending', () => {
        const folders = [makeFolder('f1', { priority: 10 }), makeFolder('f2', { priority: 30 })]
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f2' }),
        ]
        const result = computeChildren(mods, folders, null)
        const folderEntries = result.filter(
            (e): e is { type: 'folder'; folder: ModFolder } => e.type === 'folder'
        )
        expect(folderEntries[0].folder.id).toBe('f2')
        expect(folderEntries[1].folder.id).toBe('f1')
    })

    it('includes folders that have no mods', () => {
        const folders = [makeFolder('empty')]
        const result = computeChildren([], folders, null)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe('folder')
        expect((result[0] as { type: 'folder'; folder: ModFolder }).folder.id).toBe('empty')
    })

    it('hides empty folders when filtering does not expose them', () => {
        const folders = [makeFolder('empty')]
        const result = computeChildren([], folders, null, new Set())
        expect(result).toHaveLength(0)
    })

    it('only includes mods whose folderId matches parentId', () => {
        const mods = [
            makeMod('a', 1, 'A', { folderId: null }),
            makeMod('b', 2, 'B', { folderId: 'f1' }),
        ]
        const result = computeChildren(mods, [], null)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe('mod')
        expect((result[0] as ModEntry).mods[0].uid).toBe('a')
    })

    it('filters folders by visibleFolderIds when provided', () => {
        const folders = [makeFolder('f1'), makeFolder('f2')]
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f2' }),
        ]
        const result = computeChildren(mods, folders, null, new Set(['f1']))
        const folderIds = result
            .filter((e): e is { type: 'folder'; folder: ModFolder } => e.type === 'folder')
            .map((e) => e.folder.id)
        expect(folderIds).toEqual(['f1'])
    })

    it('shows all folders when visibleFolderIds is undefined', () => {
        const folders = [makeFolder('f1'), makeFolder('f2')]
        const mods = [
            makeMod('a', 1, 'A', { folderId: 'f1' }),
            makeMod('b', 2, 'B', { folderId: 'f2' }),
        ]
        const result = computeChildren(mods, folders, null, undefined)
        expect(result.filter((e) => e.type === 'folder')).toHaveLength(2)
    })
})

describe('groupChildren', () => {
    type RootGroup = Extract<ChildGroup, { type: 'root-group' }>

    it('returns empty array for empty input', () => {
        expect(groupChildren([])).toEqual([])
    })

    it('groups consecutive mods into a single root-group', () => {
        const entries: ChildEntry[] = [
            { type: 'mod', mods: [makeMod('a', 1, 'A')] },
            { type: 'mod', mods: [makeMod('b', 2, 'B')] },
        ]
        const result = groupChildren(entries)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe('root-group')
        expect((result[0] as RootGroup).groups).toHaveLength(2)
    })

    it('splits mod runs into separate root-groups when a folder appears between them', () => {
        const entries: ChildEntry[] = [
            { type: 'mod', mods: [makeMod('a', 1, 'A')] },
            { type: 'folder', folder: makeFolder('f1') },
            { type: 'mod', mods: [makeMod('b', 2, 'B')] },
        ]
        const result = groupChildren(entries)
        expect(result).toHaveLength(3)
        expect(result[0].type).toBe('root-group')
        expect(result[1].type).toBe('folder')
        expect(result[2].type).toBe('root-group')
    })

    it('emits individual folder entries for a pure folder list', () => {
        const entries: ChildEntry[] = [
            { type: 'folder', folder: makeFolder('f1') },
            { type: 'folder', folder: makeFolder('f2') },
        ]
        const result = groupChildren(entries)
        expect(result).toHaveLength(2)
        expect(result.every((g) => g.type === 'folder')).toBe(true)
    })

    it('collects trailing mods after the last folder into their own root-group', () => {
        const entries: ChildEntry[] = [
            { type: 'folder', folder: makeFolder('f1') },
            { type: 'mod', mods: [makeMod('a', 1, 'A')] },
            { type: 'mod', mods: [makeMod('b', 2, 'B')] },
        ]
        const result = groupChildren(entries)
        expect(result).toHaveLength(2)
        expect(result[0].type).toBe('folder')
        expect(result[1].type).toBe('root-group')
        expect((result[1] as RootGroup).groups).toHaveLength(2)
    })

    it('handles alternating folders and single mods correctly', () => {
        const entries: ChildEntry[] = [
            { type: 'mod', mods: [makeMod('a', 1, 'A')] },
            { type: 'folder', folder: makeFolder('f1') },
            { type: 'folder', folder: makeFolder('f2') },
            { type: 'mod', mods: [makeMod('b', 2, 'B')] },
        ]
        const result = groupChildren(entries)
        expect(result.map((g) => g.type)).toEqual(['root-group', 'folder', 'folder', 'root-group'])
    })
})

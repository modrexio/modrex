import { describe, expect, it } from 'vitest'
import { buildTree, countFiles, filterTree, type TreeNode } from './PakViewerModal'
import type { PakAsset } from '../api'

function asset(path: string, size = 10, klass: string | null = null): PakAsset {
    return { path, size, class: klass }
}

function paths(node: TreeNode): string[] {
    if (node.asset !== null) return [node.path]
    return node.children.flatMap(paths)
}

describe('buildTree', () => {
    it('groups assets under folder nodes by path segments', () => {
        const tree = buildTree([
            asset('PAYDAY3/Content/Mods/A/BP_A.uasset'),
            asset('PAYDAY3/Content/Mods/A/BP_A.uexp'),
            asset('PAYDAY3/Content/Mods/B/BP_B.uasset'),
        ])
        expect(tree.children.map((c) => c.name)).toEqual(['PAYDAY3'])
        const content = tree.children[0].children[0]
        expect(content.name).toBe('Content')
        const mods = content.children[0]
        expect(mods.children.map((c) => c.name)).toEqual(['A', 'B'])
    })

    it('treats a path without slashes as a root-level file', () => {
        const tree = buildTree([asset('RootFile.pak')])
        expect(tree.children.map((c) => c.name)).toEqual(['RootFile.pak'])
        expect(tree.children[0].asset?.path).toBe('RootFile.pak')
    })

    it('assigns each node its full prefix path', () => {
        const tree = buildTree([asset('Game/Maps/Foo.umap')])
        const maps = tree.children[0].children[0].children[0]
        expect(maps.name).toBe('Foo.umap')
        expect(maps.path).toBe('Game/Maps/Foo.umap')
    })
})

describe('countFiles', () => {
    it('counts only file nodes', () => {
        const tree = buildTree([
            asset('Game/Maps/A.umap'),
            asset('Game/Maps/B.umap'),
            asset('Game/UI/C.uasset'),
        ])
        expect(countFiles(tree)).toBe(3)
        expect(countFiles(tree.children[0].children[0])).toBe(2)
    })
})

describe('filterTree', () => {
    const tree = buildTree([
        asset('Game/Maps/Start.umap', 10, 'World'),
        asset('Game/Maps/End.umap', 20, 'World'),
        asset('Game/UI/Hud.uasset', 30, 'WidgetBlueprint'),
    ])

    it('keeps folders whose descendants match by path', () => {
        const filtered = filterTree(tree, 'start')
        expect(filtered).not.toBeNull()
        expect(paths(filtered!)).toEqual(['Game/Maps/Start.umap'])
    })

    it('matches on the asset class', () => {
        const filtered = filterTree(tree, 'widget')
        expect(filtered).not.toBeNull()
        expect(paths(filtered!)).toEqual(['Game/UI/Hud.uasset'])
    })

    it('is case-insensitive', () => {
        const filtered = filterTree(tree, 'START')
        expect(paths(filtered!)).toEqual(['Game/Maps/Start.umap'])
    })

    it('prunes folders with no matching descendants', () => {
        const filtered = filterTree(tree, 'missing')
        expect(filtered).toBeNull()
    })
})

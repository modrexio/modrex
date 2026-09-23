import { expect, it } from 'vitest'
import type { InstalledMod, Mod, ModFile, ModSummary } from '../../shared/types'
import type { VersionState } from './modVersions'
import { updatableMods, resolveUpdateTarget } from './updatePolicy'

const installed: InstalledMod = {
    id: 1,
    uid: 'one',
    name: 'Mod',
    remoteId: '1',
    version: 'first',
    filename: 'a',
    enabled: true,
    installedAt: '',
    fileId: 10,
}

const noSummaries = new Map<number, ModSummary>()

it('requires a fresh, explicit remote version and a comparable installed version', () => {
    for (const state of [
        { status: 'pending' },
        { status: 'unversioned' },
        { status: 'missing' },
        { status: 'failed', error: 'offline' },
        { status: 'stale', previous: { status: 'known', version: 'different' } },
        { status: 'known', version: 'first' },
    ] as VersionState[]) {
        expect(updatableMods([installed], new Map([[1, state]]), noSummaries)).toEqual([])
    }
    const versions = new Map<number, VersionState>([
        [1, { status: 'known', version: 'anything the author writes' }],
    ])
    expect(updatableMods([installed], versions, noSummaries)).toEqual([installed])
    expect(
        updatableMods(
            [{ ...installed, version: '', updateStatus: 'outdated' }],
            versions,
            noSummaries
        )
    ).toHaveLength(1)
    expect(
        updatableMods(
            [{ ...installed, version: 'anything the author writes', updateStatus: 'outdated' }],
            versions,
            noSummaries
        )
    ).toHaveLength(1)
    expect(
        updatableMods([{ ...installed, missing: true }, installed], versions, noSummaries)
    ).toEqual([installed])
})

function file(id: number): ModFile {
    return { id, download_url: `https://storage.test/${id}` } as ModFile
}

const detail = {
    id: 1,
    version: 'second',
    download: { id: 10, download_url: 'https://storage.test/10', url: null },
    download_id: null,
    files_are_versions: true,
} as Mod

it('installs without asking when the new file is unambiguous', () => {
    const newest = { ...detail, download: { ...detail.download!, id: 11 } }
    const files = [file(11), file(10)]
    expect(resolveUpdateTarget([installed], detail, files).status).toBe('install')
    expect(resolveUpdateTarget([installed], newest, files).status).toBe('install')
    expect(
        resolveUpdateTarget([installed], { ...newest, files_are_versions: false }, [file(11)])
            .status
    ).toBe('install')
    expect(
        resolveUpdateTarget(
            [{ ...installed, updateStatus: 'outdated' }],
            {
                ...detail,
                version: 'first',
            },
            files
        ).status
    ).toBe('install')
})

it('asks which file to install when the other files can be variants', () => {
    const files = [file(12), file(11), file(10)]
    const variants = { ...detail, download: null, files_are_versions: false }
    const pinned = { ...detail, download: { ...detail.download!, id: 12 }, download_id: 12 }
    expect(resolveUpdateTarget([installed], variants, files).status).toBe('choose')
    expect(resolveUpdateTarget([installed], pinned, files).status).toBe('choose')
    expect(resolveUpdateTarget([installed], pinned, [file(12), file(11)]).status).toBe('install')
    expect(
        resolveUpdateTarget(
            [
                { ...installed, updateStatus: 'outdated' },
                { ...installed, fileId: 12 },
            ],
            { ...pinned, version: 'first' },
            files
        ).status
    ).toBe('choose')
    expect(
        resolveUpdateTarget(
            [
                { ...installed, updateStatus: 'outdated' },
                { ...installed, fileId: 12 },
            ],
            { ...pinned, version: 'first' },
            [file(12), file(11)]
        ).status
    ).toBe('install')
    expect(
        resolveUpdateTarget([{ ...installed, fileId: undefined }], pinned, [file(12), file(11)])
            .status
    ).toBe('choose')
    expect(
        resolveUpdateTarget([installed, { ...installed, fileId: 11 }], detail, files).status
    ).toBe('install')
})

it('marks downloads Modrex cannot install as unavailable', () => {
    const files = [file(10)]
    const link = { ...detail.download!, download_url: null, url: 'https://x.test' }
    for (const mod of [
        { ...detail, disable_mod_managers: true },
        { ...detail, download: link },
    ]) {
        expect(resolveUpdateTarget([installed], mod, files).status).toBe('unavailable')
    }
    expect(resolveUpdateTarget([installed], { ...detail, download: null }, []).status).toBe(
        'unavailable'
    )
})

it('does not offer updates for mods Modrex cannot download', () => {
    const versions = new Map<number, VersionState>([[1, { status: 'known', version: 'new' }]])
    for (const summary of [
        { download_type: 'link', disable_mod_managers: false },
        { download_type: 'file', disable_mod_managers: true },
    ]) {
        const summaries = new Map([[1, summary as ModSummary]])
        expect(updatableMods([installed], versions, summaries)).toEqual([])
    }
})

it('skips mods whose installed version is already current', () => {
    expect(
        resolveUpdateTarget([installed], { ...detail, version: 'first' }, [file(10)]).status
    ).toBe('unchanged')
    expect(resolveUpdateTarget([installed], { ...detail, version: '' }, [file(10)]).status).toBe(
        'unchanged'
    )
})

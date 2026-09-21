import { expect, it } from 'vitest'
import type { InstalledMod, Mod } from '../../shared/types'
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

it('requires a fresh, explicit remote version and a comparable installed version', () => {
    for (const state of [
        { status: 'pending' },
        { status: 'unversioned' },
        { status: 'missing' },
        { status: 'failed', error: 'offline' },
        { status: 'stale', previous: { status: 'known', version: 'different' } },
        { status: 'known', version: 'first' },
    ] as VersionState[]) {
        expect(updatableMods([installed], new Map([[1, state]]))).toEqual([])
    }
    const versions = new Map<number, VersionState>([
        [1, { status: 'known', version: 'anything the author writes' }],
    ])
    expect(updatableMods([installed], versions)).toEqual([installed])
    expect(
        updatableMods([{ ...installed, version: '', updateStatus: 'outdated' }], versions)
    ).toHaveLength(1)
    expect(
        updatableMods(
            [{ ...installed, version: 'anything the author writes', updateStatus: 'outdated' }],
            versions
        )
    ).toHaveLength(1)
    expect(updatableMods([{ ...installed, missing: true }, installed], versions)).toEqual([
        installed,
    ])
})

it('never infers consent to change a selected downloadable', () => {
    const detail = {
        version: 'second',
        download: { id: 10, download_url: 'https://storage.test/a' },
    } as Mod
    expect(resolveUpdateTarget([installed], detail).status).toBe('ready')
    expect(resolveUpdateTarget([{ ...installed, fileId: 11 }], detail).status).toBe('review')
    expect(resolveUpdateTarget([installed, { ...installed, fileId: 11 }], detail).status).toBe(
        'review'
    )
    expect(resolveUpdateTarget([installed], { ...detail, version: 'first' }).status).toBe(
        'unchanged'
    )
    expect(
        resolveUpdateTarget([{ ...installed, updateStatus: 'outdated' }], {
            ...detail,
            version: 'first',
        }).status
    ).toBe('ready')
    expect(resolveUpdateTarget([installed], { ...detail, download: null }).status).toBe('review')
    expect(resolveUpdateTarget([installed], { ...detail, disable_mod_managers: true }).status).toBe(
        'review'
    )
})

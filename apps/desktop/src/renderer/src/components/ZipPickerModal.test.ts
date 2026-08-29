import { beforeEach, describe, it, expect, vi } from 'vitest'
import type * as ZipPickerMod from './ZipPickerModal'
import type { InstalledMod } from '../../../shared/types'
import type { ZipMultiPakPayload } from './ZipPickerModal'

function makeInstalled(overrides: Partial<InstalledMod> = {}): InstalledMod {
    const id = overrides.id ?? 100
    return {
        uid: 'uid',
        id,
        // InstalledMod.id is an opaque local key; payload.modId (what
        // computeAutoUpdateSelection actually matches against) is always real, so these
        // fixtures need remoteId set to match, mirroring modId's real value by default.
        remoteId: id >= 0 ? String(id) : undefined,
        name: 'Some Mod',
        version: '1.0',
        filename: 'SomeMod.pak',
        enabled: true,
        installedAt: '',
        ...overrides,
    }
}

function makePayload(overrides: Partial<ZipMultiPakPayload> = {}): ZipMultiPakPayload {
    return {
        archiveHandle: 'handle-abc',
        entries: ['VariantA.pak', 'VariantB.pak', 'VariantC.pak'],
        modId: 100,
        modName: 'Some Mod',
        fileId: 200,
        fileType: 'zip',
        modVersion: '2.0',
        ...overrides,
    }
}

let mockInstallFromZipEntry: ReturnType<typeof vi.fn>
let mockDeleteTempFile: ReturnType<typeof vi.fn>
let mockCreateFolder: ReturnType<typeof vi.fn>
let mod: typeof ZipPickerMod

beforeEach(async () => {
    vi.resetModules()

    mockInstallFromZipEntry = vi.fn().mockResolvedValue(undefined)
    mockDeleteTempFile = vi.fn().mockResolvedValue(undefined)
    mockCreateFolder = vi.fn()

    vi.doMock('../api', () => ({
        api: {
            installFromZipEntry: mockInstallFromZipEntry,
            discardStagedArchive: mockDeleteTempFile,
            createFolder: mockCreateFolder,
            onDownloadProgress: vi.fn(),
        },
    }))
    vi.doMock('../archiveEntriesCache', () => ({ setArchiveEntries: vi.fn() }))

    mod = await import('./ZipPickerModal')
})

describe('computeAutoUpdateSelection', () => {
    it('matches previously-installed file variants by filename across a version bump', () => {
        const installed = [
            makeInstalled({ uid: 'a', filename: '001_VariantA.pak' }),
            makeInstalled({ uid: 'c', filename: '003_VariantC.pak' }),
        ]
        const payload = makePayload()
        const result = mod.computeAutoUpdateSelection(payload, installed)
        expect(result).toEqual(['VariantA.pak', 'VariantC.pak'])
    })

    it('returns null for a fresh install with no prior entries for this mod id', () => {
        const installed = [makeInstalled({ id: 999, filename: 'Unrelated.pak' })]
        const payload = makePayload()
        expect(mod.computeAutoUpdateSelection(payload, installed)).toBeNull()
    })

    it('returns null when filenames no longer match anything previously installed', () => {
        const installed = [makeInstalled({ filename: '001_TotallyDifferentName.pak' })]
        const payload = makePayload()
        expect(mod.computeAutoUpdateSelection(payload, installed)).toBeNull()
    })

    it('excludes entries already installed under the same fileId from the match set', () => {
        const installed = [
            makeInstalled({
                uid: '200_VariantA',
                fileId: 200,
                filename: 'VariantA.pak',
            }),
            makeInstalled({ uid: 'c', filename: '003_VariantC.pak' }),
        ]
        const payload = makePayload()
        // VariantA is already installed from this exact archive, so it's excluded from the
        // "to install" set returned for an auto-resolve pass, so it is not pending work.
        expect(mod.computeAutoUpdateSelection(payload, installed)).toEqual(['VariantC.pak'])
    })

    it('ignores missing (uninstalled) prior entries', () => {
        const installed = [makeInstalled({ filename: '001_VariantA.pak', missing: true })]
        const payload = makePayload()
        expect(mod.computeAutoUpdateSelection(payload, installed)).toBeNull()
    })
})

describe('installZipPickerEntries', () => {
    it('installs only the given entries and cleans up the temp file', async () => {
        const payload = makePayload()
        await mod.installZipPickerEntries(
            payload,
            ['VariantA.pak', 'VariantC.pak'],
            '/game',
            'pd3',
            null,
            async () => {}
        )
        expect(mockInstallFromZipEntry).toHaveBeenCalledTimes(2)
        expect(mockInstallFromZipEntry).toHaveBeenNthCalledWith(
            1,
            payload.archiveHandle,
            'VariantA.pak',
            payload.modId,
            payload.modName,
            payload.fileId,
            payload.fileType,
            payload.modVersion,
            '/game',
            'pd3',
            null,
            payload.targetTag,
            payload.entryKind
        )
        expect(mockDeleteTempFile).toHaveBeenCalledWith(payload.archiveHandle)
    })

    it('calls onRefreshInstalled after each entry', async () => {
        const payload = makePayload()
        const onRefreshInstalled = vi.fn().mockResolvedValue(undefined)
        await mod.installZipPickerEntries(
            payload,
            ['VariantA.pak', 'VariantC.pak'],
            '/game',
            'pd3',
            null,
            onRefreshInstalled
        )
        expect(onRefreshInstalled).toHaveBeenCalledTimes(2)
    })

    it('propagates an install failure without deleting the temp file', async () => {
        mockInstallFromZipEntry.mockRejectedValueOnce(new Error('boom'))
        const payload = makePayload()
        await expect(
            mod.installZipPickerEntries(
                payload,
                ['VariantA.pak'],
                '/game',
                'pd3',
                null,
                async () => {}
            )
        ).rejects.toThrow('boom')
        expect(mockDeleteTempFile).not.toHaveBeenCalled()
    })
})

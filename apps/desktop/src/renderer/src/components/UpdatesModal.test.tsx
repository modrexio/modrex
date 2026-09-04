// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as UpdatesModalMod from './UpdatesModal'
import type { InstalledMod, ModSummary } from '../../../shared/types'

function makeInstalled(id: number, overrides: Partial<InstalledMod> = {}): InstalledMod {
    return {
        uid: `uid-${id}`,
        id,
        // InstalledMod.id is an opaque local key; api.installMod always needs the real
        // id, which only ever lives in remoteId. These fixtures use the same number
        // for both for simplicity, matching what mockInstallMod is asserted against.
        remoteId: String(id),
        name: `Mod ${id}`,
        version: '1.0',
        filename: `Mod${id}.pak`,
        enabled: true,
        installedAt: '',
        ...overrides,
    }
}

function makeMod(id: number): ModSummary {
    return {
        id,
        name: `Mod ${id}`,
        desc: '',
        short_desc: '',
        version: '2.0',
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: '',
        bumped_at: '',
        category_id: 0,
        has_download: false,
        disable_mod_managers: null,
        thumbnail: null,
        download: null,
        user: { id: null, name: 'Test', donation_url: null, avatar: null, avatar_has_thumb: null },
    }
}

const PICKER_OUTCOME_FOR_MOD_1 = {
    needsPicker: {
        archiveHandle: 'handle-abc',
        entryIds: [0],
        entries: ['VariantA.pak', 'VariantB.pak'],
        targetTag: null,
        modId: 1,
        modName: 'Mod 1',
        fileId: 555,
        fileType: 'zip',
        modVersion: '2.0',
    },
}

let mockInstallMod: ReturnType<typeof vi.fn>
let mockInstallFromZipEntry: ReturnType<typeof vi.fn>
let mockDeleteTempFile: ReturnType<typeof vi.fn>
let UpdatesModal: typeof UpdatesModalMod.UpdatesModal

beforeEach(async () => {
    vi.resetModules()

    mockInstallMod = vi.fn()
    mockInstallFromZipEntry = vi.fn().mockResolvedValue(undefined)
    mockDeleteTempFile = vi.fn().mockResolvedValue(undefined)

    vi.doMock('../api', () => ({
        api: {
            installMod: mockInstallMod,
            installFromZipEntry: mockInstallFromZipEntry,
            discardStagedArchive: mockDeleteTempFile,
        },
    }))

    const mod = await import('./UpdatesModal')
    UpdatesModal = mod.UpdatesModal
})

describe('UpdatesModal batch update', () => {
    it('auto-installs all entries for a multi-pak mod without re-prompting, even when filenames changed', async () => {
        // mod 1's archive has entries whose names don't match any installed file (installed=[]
        // below), simulating a version where the author renamed the pak files.
        mockInstallMod.mockImplementation(async (modId: number) =>
            modId === 1 ? PICKER_OUTCOME_FOR_MOD_1 : 'installed'
        )

        const updatable = [makeInstalled(1), makeInstalled(2)]
        const modData = new Map([
            [1, makeMod(1)],
            [2, makeMod(2)],
        ])
        const onRefreshInstalled = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()

        render(
            <UpdatesModal
                updatable={updatable}
                modData={modData}
                installed={[]}
                gamePath="/game"
                gameId="pd3"
                visible={true}
                onRefreshInstalled={onRefreshInstalled}
                onClose={onClose}
                onOpenDetail={vi.fn()}
            />
        )

        fireEvent.click(screen.getByText('Update Selected (2)'))

        await waitFor(() => expect(onClose).toHaveBeenCalled())
        expect(mockInstallMod).toHaveBeenCalledWith(1, '/game', 'pd3')
        expect(mockInstallMod).toHaveBeenCalledWith(2, '/game', 'pd3')
        expect(mockInstallFromZipEntry).toHaveBeenCalledTimes(2)
    })
})

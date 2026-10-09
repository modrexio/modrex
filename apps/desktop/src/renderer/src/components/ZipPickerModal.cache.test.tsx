// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../api'
import { getArchiveEntries } from '../archiveEntriesCache'
import { ZipPickerModal, type ZipMultiPakPayload } from './ZipPickerModal'

vi.mock('../api', () => ({
    api: {
        installFromZipEntry: vi.fn(),
        discardStagedArchive: vi.fn(() => Promise.resolve()),
    },
}))

const payload: ZipMultiPakPayload = {
    archiveHandle: 'archive',
    entries: ['WorkshopVariant.pak'],
    entryIds: [0],
    modId: 100,
    modName: 'Package mod',
    fileId: 200,
    fileType: 'zip',
    modVersion: '1',
}
const pickerContext = {
    gameId: 'pd3',
    gamePath: 'G:/Games',
    installedFiles: [],
    onRefreshInstalled: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

test.each([undefined, 'modworkshop'] as const)(
    'preserves the %s source cache when Nexus uses the same numeric file ID',
    async (source) => {
        const workshop = render(
            <ZipPickerModal {...pickerContext} payload={{ ...payload, source }} />
        )
        expect(getArchiveEntries('pd3', payload.fileId)).toEqual(['WorkshopVariant.pak'])
        workshop.unmount()
        const installEntry = vi.fn(() => Promise.resolve())
        render(
            <ZipPickerModal
                {...pickerContext}
                installEntry={installEntry}
                payload={{
                    ...payload,
                    source: 'nexus',
                    archiveHandle: 'nexus-review',
                    entries: ['NexusVariant.pak'],
                    entryIds: [9],
                }}
            />
        )
        expect(getArchiveEntries('pd3', payload.fileId)).toEqual(['WorkshopVariant.pak'])
        fireEvent.click(screen.getByRole('button', { name: 'Install Selected (1)' }))
        await waitFor(() => expect(pickerContext.onClose).toHaveBeenCalledOnce())
        expect(installEntry).toHaveBeenCalledExactlyOnceWith(0, null, undefined)
        expect(api.installFromZipEntry).not.toHaveBeenCalled()
        expect(api.discardStagedArchive).toHaveBeenCalledExactlyOnceWith('nexus-review')
    }
)

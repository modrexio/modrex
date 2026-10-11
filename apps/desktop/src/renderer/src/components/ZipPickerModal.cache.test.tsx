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

test('shared packages start with no selected variants and install only the explicit choice', async () => {
    const installEntry = vi.fn(() => Promise.resolve())
    render(
        <ZipPickerModal
            {...pickerContext}
            installEntry={installEntry}
            payload={{
                ...payload,
                sharedPaks: true,
                source: 'nexus',
                entries: ['Hard/Hard_P.pak', 'Realistic/Realistic_P.pak'],
                entryIds: [5, 8],
            }}
        />
    )
    expect(
        screen.getByRole('button', { name: 'Install Selected (0)' }).hasAttribute('disabled')
    ).toBe(true)
    expect(installEntry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Realistic/Realistic_P.pak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install Selected (1)' }))
    await waitFor(() => expect(pickerContext.onClose).toHaveBeenCalledOnce())
    expect(installEntry).toHaveBeenCalledExactlyOnceWith(1, null, undefined)
})

test('reopening a local shared archive keeps same-basename variants distinct', async () => {
    const localPayload: ZipMultiPakPayload = {
        ...payload,
        sharedPaks: true,
        modId: 0,
        fileId: -123,
        entries: ['Hard/Payload_P.pak', 'Realistic/Payload_P.pak'],
        entryIds: [5, 8],
    }
    const first = render(<ZipPickerModal {...pickerContext} payload={localPayload} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hard/Payload_P.pak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install Selected (1)' }))
    await waitFor(() => expect(pickerContext.onClose).toHaveBeenCalledOnce())
    expect(api.installFromZipEntry).toHaveBeenCalledExactlyOnceWith(
        'archive',
        5,
        0,
        'Package mod',
        -123,
        'zip',
        '1',
        'G:/Games',
        'pd3',
        null,
        undefined,
        undefined
    )
    first.unmount()
    vi.clearAllMocks()
    render(
        <ZipPickerModal
            {...pickerContext}
            payload={localPayload}
            installedFiles={[
                {
                    uid: 'local:-123:entry:Hard/Payload_P.pak',
                    id: -456,
                    name: 'Package mod',
                    source: 'local',
                    version: '',
                    filename: 'Payload_P.pak',
                    enabled: true,
                    installedAt: '',
                },
            ]}
        />
    )
    expect(
        screen.getByRole('checkbox', { name: 'Hard/Payload_P.pak' }).hasAttribute('disabled')
    ).toBe(true)
    expect(
        screen.getByRole('checkbox', { name: 'Realistic/Payload_P.pak' }).hasAttribute('disabled')
    ).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Realistic/Payload_P.pak' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install Selected (1)' }))
    await waitFor(() => expect(pickerContext.onClose).toHaveBeenCalledOnce())
    expect(api.installFromZipEntry).toHaveBeenCalledExactlyOnceWith(
        'archive',
        8,
        0,
        'Package mod',
        -123,
        'zip',
        '1',
        'G:/Games',
        'pd3',
        null,
        undefined,
        undefined
    )
    expect(getArchiveEntries('pd3', -123)).toBeNull()
})

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

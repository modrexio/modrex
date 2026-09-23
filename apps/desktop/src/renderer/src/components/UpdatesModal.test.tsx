// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { InstalledMod, Mod } from '../../../shared/types'

const { install, discard, openExternal, refresh, files, logError } = vi.hoisted(() => ({
    install: vi.fn(),
    discard: vi.fn(),
    openExternal: vi.fn(),
    refresh: vi.fn(),
    files: vi.fn(),
    logError: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-log', () => ({ error: logError }))
vi.mock('../api', () => ({
    api: { installMod: install, discardStagedArchive: discard, openExternal },
}))
vi.mock('../modCache', () => ({ refreshModDetail: refresh, getCachedModFiles: files }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
import { UpdatesModal } from './UpdatesModal'

function installed(id: number): InstalledMod {
    return {
        id,
        uid: String(id),
        remoteId: String(id),
        fileId: id * 10,
        name: 'Mod ' + id,
        version: 'old',
        filename: 'one.pak',
        enabled: true,
        installedAt: '',
    }
}
function detail(id: number): Mod {
    return {
        id,
        name: 'Mod ' + id,
        version: 'new',
        desc: '',
        short_desc: '',
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: '',
        bumped_at: '',
        category_id: 0,
        has_download: true,
        disable_mod_managers: null,
        download_type: null,
        thumbnail: null,
        download: {
            id: id * 10,
            version: 'new',
            download_url: 'https://storage.test/a.zip',
            type: 'zip',
            url: null,
            size: 1,
        },
        download_id: null,
        files_are_versions: true,
        user: {
            id: null,
            name: 'Author',
            donation_url: null,
            avatar: null,
            avatar_has_thumb: null,
        },
        changelog: null,
        instructions: null,
        license: null,
        repo_url: null,
        donation: null,
        banner: null,
        images: [],
        dependencies: [],
        instructs_template: null,
        tags: [],
        members: [],
    }
}
function mount(entries: InstalledMod[] = []) {
    const mods = [installed(1), installed(2)]
    const open = vi.fn()
    const close = vi.fn()
    render(
        <UpdatesModal
            updatable={mods}
            installed={[...mods, ...entries]}
            modData={
                new Map([
                    [1, detail(1)],
                    [2, detail(2)],
                ])
            }
            updateVersions={
                new Map([
                    [1, 'new'],
                    [2, 'new'],
                ])
            }
            gamePath="/game"
            gameId="pd3"
            visible={true}
            onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
            onClose={close}
            onOpenDetail={open}
        />
    )
    return { open, close }
}

beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    install.mockResolvedValue('installed')
    refresh.mockImplementation(async (id: number) => detail(id))
    files.mockImplementation(async (id: number) => [{ id: id * 10, name: 'File ' + id }])
})

describe('update target revalidation', () => {
    it('installs each unambiguous update without leaving the modal flow', async () => {
        const { open, close } = mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(close).toHaveBeenCalled())
        expect(refresh.mock.calls).toEqual([[1], [2]])
        expect(install.mock.calls.map((call) => [call[0], call[3]])).toEqual([
            [1, undefined],
            [2, undefined],
        ])
        expect(open).not.toHaveBeenCalled()
        expect(screen.getAllByText('old to new')).toHaveLength(2)
    })

    it('asks for a file when variants make the choice ambiguous, then resumes', async () => {
        refresh.mockImplementation(async (id: number) =>
            id === 1 ? { ...detail(1), download: null, files_are_versions: false } : detail(2)
        )
        files.mockImplementation(async (id: number) =>
            id === 1
                ? [
                      { id: 11, name: 'Variant A' },
                      { id: 12, name: 'Variant B' },
                  ]
                : [{ id: 20, name: 'File 2' }]
        )
        const { open, close } = mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        fireEvent.click(await screen.findByText('Variant B'))
        fireEvent.click(screen.getByText('Update'))
        await waitFor(() => expect(close).toHaveBeenCalled())
        expect(install.mock.calls.map((call) => [call[0], call[3]])).toEqual([
            [1, 12],
            [2, undefined],
        ])
        expect(open).not.toHaveBeenCalled()
    })

    it('keeps the list open to say which mod it could not update', async () => {
        refresh.mockImplementation(async (id: number) =>
            id === 1 ? { ...detail(1), disable_mod_managers: true } : detail(2)
        )
        const { close } = mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
        expect(await screen.findByText("Mod 1 can't be updated from Modrex.")).toBeTruthy()
        expect(close).not.toHaveBeenCalled()
        expect(openExternal).not.toHaveBeenCalled()
    })

    it('does not open the archive picker when every entry is already installed', async () => {
        const archive = {
            archiveHandle: 'h',
            entries: ['A.pak', 'B.pak'],
            entryIds: [0, 1],
            modId: 1,
            modName: 'Mod 1',
            fileId: 10,
            fileType: 'zip',
            modVersion: 'new',
        }
        install.mockImplementation(async (id: number) =>
            id === 1 ? { needsPicker: archive } : 'installed'
        )
        const entries = ['A', 'B'].map((stem) => ({
            ...installed(1),
            uid: `10_${stem}`,
            filename: `${stem}.pak`,
        }))
        const { close } = mount(entries)
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(close).toHaveBeenCalled())
        expect(discard).toHaveBeenCalledWith('h')
        expect(screen.queryByText('Install from archive')).toBeNull()
    })

    it('hides the list while an archive picker is open', async () => {
        install.mockResolvedValue({
            needsPicker: {
                archiveHandle: 'h',
                entries: ['A.pak', 'B.pak'],
                entryIds: [0, 1],
                modId: 1,
                modName: 'Mod 1',
                fileId: 10,
                fileType: 'zip',
                modVersion: 'new',
            },
        })
        mount()
        fireEvent.click(screen.getAllByText('Update')[0])
        expect(await screen.findAllByText('Install from archive')).not.toHaveLength(0)
        expect(screen.queryByText('Available updates (2)')).toBeNull()
    })

    it('does not install when fresh detail fails', async () => {
        refresh.mockRejectedValue(new Error('offline'))
        mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() =>
            expect(logError).toHaveBeenCalledWith('Mod update failed: Error: offline')
        )
        expect(install).not.toHaveBeenCalled()
        expect(screen.getByText('Update failed. Check your connection and try again.')).toBeTruthy()
    })

    it('renders an explicit available version when installed metadata is incomplete', () => {
        const mod = { ...installed(1), version: '', updateStatus: 'outdated' as const }
        render(
            <UpdatesModal
                updatable={[mod]}
                installed={[mod]}
                modData={new Map()}
                updateVersions={new Map([[1, 'new']])}
                gamePath="/game"
                gameId="pd3"
                visible={true}
                onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
                onClose={vi.fn()}
                onOpenDetail={vi.fn()}
            />
        )
        expect(screen.getByText('new available')).toBeTruthy()
        expect(screen.getByText('Mod 1')).toBeTruthy()
    })
})

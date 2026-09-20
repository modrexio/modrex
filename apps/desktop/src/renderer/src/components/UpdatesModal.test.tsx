// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { InstalledMod, Mod } from '../../../shared/types'

const { install, refresh } = vi.hoisted(() => ({ install: vi.fn(), refresh: vi.fn() }))
vi.mock('../api', () => ({ api: { installModFile: install } }))
vi.mock('../modCache', () => ({ refreshModDetail: refresh }))
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
        thumbnail: null,
        download: {
            id: id * 10,
            version: 'new',
            download_url: 'https://storage.test/a.zip',
            type: 'zip',
            url: null,
            size: 1,
        },
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
function mount() {
    const mods = [installed(1), installed(2)]
    const open = vi.fn()
    const close = vi.fn()
    render(
        <UpdatesModal
            updatable={mods}
            installed={mods}
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
})

describe('update target revalidation', () => {
    it('uses the freshly checked explicit target for each unchanged selection', async () => {
        const { close } = mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(close).toHaveBeenCalled())
        expect(refresh.mock.calls).toEqual([[1], [2]])
        expect(install.mock.calls.map((call) => [call[0], call[2]])).toEqual([
            [1, 10],
            [2, 20],
        ])
        expect(screen.getAllByText('old to new')).toHaveLength(2)
    })

    it('stops the queue and opens review instead of guessing a changed default', async () => {
        refresh.mockResolvedValue({ ...detail(1), download: { ...detail(1).download!, id: 999 } })
        const { open } = mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(open).toHaveBeenCalledWith(1))
        expect(install).not.toHaveBeenCalled()
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('does not install when fresh detail fails', async () => {
        refresh.mockRejectedValue(new Error('offline'))
        mount()
        fireEvent.click(screen.getByText('Update Selected (2)'))
        await waitFor(() => expect(refresh).toHaveBeenCalled())
        expect(install).not.toHaveBeenCalled()
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

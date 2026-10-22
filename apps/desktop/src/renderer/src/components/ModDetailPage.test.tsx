// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { InstallOutcome } from '../../../shared/bindings'
import type { Mod, ModFile } from '../../../shared/types'

const transport = vi.hoisted(() => ({
    events: new Map<string, Set<(event: { payload: unknown }) => void>>(),
    installFile: vi.fn(),
    installMod: vi.fn(),
    shellOpenExternal: vi.fn(),
    recordSuccessfulInstall: vi.fn(),
    refreshInstalled: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
    listen: (name: string, callback: (event: { payload: unknown }) => void) => {
        const listeners = transport.events.get(name) ?? new Set()
        listeners.add(callback)
        transport.events.set(name, listeners)
        return Promise.resolve(() => listeners.delete(callback))
    },
}))
vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }))
vi.mock('../../../shared/bindings', () => ({
    commands: {
        installFile: transport.installFile,
        installMod: transport.installMod,
        shellOpenExternal: transport.shellOpenExternal,
        recordSuccessfulInstall: transport.recordSuccessfulInstall,
    },
}))
vi.mock('../gameData', () => ({ refreshInstalled: transport.refreshInstalled }))
vi.mock('../modCache', () => ({
    getModCacheEntry: () => ({ mod }),
    getFilesCacheEntry: () => ({ files: workshopFiles }),
    getLinksCacheEntry: () => ({ links: [] }),
    getCachedMod: async () => mod,
    getCachedModFiles: async () => workshopFiles,
    getCachedModLinks: async () => [],
}))
vi.mock('../nexusModCache', () => ({
    getNexusModCacheEntry: () => ({ mod }),
    getNexusFilesCacheEntry: () => ({ files: nexusFiles }),
    getCachedNexusMod: async () => mod,
    getCachedNexusModFiles: async () => nexusFiles,
}))
vi.mock('../sources', () => ({ nativeIdFor: () => 'readyornot' }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
vi.mock('@modrex/scrollbars', () => ({ overlayScrollbar: () => ({ destroy: () => {} }) }))
vi.mock('../../../../assets/icons/nexusmods.svg?react', () => ({ default: () => null }))

import { api } from '../api'
import { finishInstall, getInstallOperations } from '../installState'
import { ModDetailPage } from './ModDetailPage'
import { TooltipProvider } from './Tooltip'

const mod: Mod = {
    id: 340,
    name: 'PMC Baker Company',
    desc: 'Mod description',
    short_desc: '',
    legacy_markup: false,
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
    user: { id: 1, name: 'Author', donation_url: null, avatar: null, avatar_has_thumb: null },
    version: '1.2.2',
    download: null,
    download_id: null,
    files_are_versions: false,
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

const mainFile: ModFile = {
    id: 13,
    name: 'Main file',
    version: '1.2.2',
    size: 100,
    type: 'zip',
    download_url: 'https://example.test/main.zip',
    url: 'https://www.nexusmods.com/readyornot/mods/340?tab=files&file_id=13',
    image_id: null,
    desc: null,
    label: 'MAIN',
    downloads: null,
    created_at: null,
}
const workshopFiles = [mainFile, { ...mainFile, id: 14, name: 'Optional file' }]
const nexusFiles = workshopFiles.map((file) => ({ ...file, download_url: '' }))

function pending<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: string) => void
    const promise = new Promise<T>((accept, refuse) => {
        resolve = accept
        reject = refuse
    })
    return { promise, resolve, reject }
}

async function emit(name: string, payload: unknown) {
    await act(async () => {
        transport.events.get(name)?.forEach((listener) => listener({ payload }))
    })
}

function showPage(props: Partial<ComponentProps<typeof ModDetailPage>> = {}) {
    return render(
        <TooltipProvider>
            <ModDetailPage
                modId={mod.id}
                activeGame="ron"
                gamePath="C:/game"
                installed={[]}
                onBack={() => {}}
                onRefreshInstalled={async () => {}}
                {...props}
            />
        </TooltipProvider>
    )
}

function downloads() {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Downloads (2)' }))
}

let stopObserving: () => void

beforeEach(() => {
    vi.clearAllMocks()
    transport.shellOpenExternal.mockResolvedValue(undefined)
    transport.recordSuccessfulInstall.mockResolvedValue(undefined)
    transport.refreshInstalled.mockResolvedValue(undefined)
    stopObserving = api.observeInstalls()
})

afterEach(() => {
    cleanup()
    stopObserving()
    for (const game of ['ron', 'pd3']) {
        for (const operation of getInstallOperations(game)) finishInstall(operation.id)
    }
    transport.events.clear()
})

describe('mod detail installation feedback', () => {
    it('keeps the Nexus header and file row synchronized across tab switches and installation', async () => {
        const page = showPage({ source: 'nexus' })
        downloads()
        fireEvent.click(screen.getAllByRole('button', { name: 'Download via Nexus' })[0]!)
        await waitFor(() => expect(transport.shellOpenExternal).toHaveBeenCalledTimes(1))
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Waiting for browser...' })
                .disabled
        ).toBe(true)

        await emit('nxm:install-started', { gameId: 'ron', modId: mod.id, fileId: 13 })
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Preparing...' }).disabled
        ).toBe(true)
        await emit('download:progress', {
            download_id: 'nxm:ron:340:13',
            game_id: 'ron',
            downloaded: 1,
            total: 100,
        })
        expect(screen.getAllByText('1%')).toHaveLength(2)
        expect(screen.getByRole<HTMLButtonElement>('button', { name: '1%' }).disabled).toBe(true)
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Download via Nexus' }).disabled
        ).toBe(true)

        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Description' }))
        expect(screen.getByRole('tab', { name: 'Description' }).getAttribute('data-state')).toBe(
            'active'
        )
        expect(screen.getByRole<HTMLButtonElement>('button', { name: '1%' }).disabled).toBe(true)
        downloads()
        expect(screen.getAllByText('1%')).toHaveLength(2)
        page.unmount()
        showPage({ source: 'nexus' })
        downloads()
        expect(screen.getAllByText('1%')).toHaveLength(2)
        await emit('download:finished', { download_id: 'nxm:ron:340:13', game_id: 'ron' })
        expect(screen.queryByText('1%')).toBeNull()
        expect(screen.getAllByText('Installing...')).toHaveLength(2)
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Installing...' }).disabled
        ).toBe(true)

        const refresh = pending<void>()
        transport.refreshInstalled.mockReturnValueOnce(refresh.promise)
        await emit('nxm:install-complete', { gameId: 'ron', modId: mod.id, fileId: 13 })
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Installing...' }).disabled
        ).toBe(true)
        await act(async () => refresh.resolve())
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled).toBe(
            false
        )
        expect(screen.getAllByRole('button', { name: 'Download via Nexus' })).toHaveLength(2)
    })

    it('does not clear a Nexus download for another mod, another game or an invalid handoff', async () => {
        showPage({ source: 'nexus' })
        downloads()
        await emit('nxm:install-started', { gameId: 'ron', modId: mod.id, fileId: 13 })
        await emit('download:progress', {
            download_id: 'nxm:ron:340:13',
            game_id: 'ron',
            downloaded: 1,
            total: 100,
        })
        for (const failure of [
            { gameId: 'ron', modId: 341, fileId: 13 },
            { gameId: 'pd3', modId: 340, fileId: 13 },
            { gameId: null, modId: null, fileId: null },
        ]) {
            await emit('nxm:install-failed', { ...failure, message: 'Unrelated failure' })
        }
        expect(screen.getAllByText('1%')).toHaveLength(2)
        expect(screen.queryByText('Unrelated failure')).toBeNull()

        await emit('nxm:install-failed', {
            gameId: 'ron',
            modId: mod.id,
            fileId: 13,
            message: 'Nexus download failed',
        })
        expect(screen.getAllByText('Nexus download failed')).toHaveLength(2)
        expect(screen.queryByText('1%')).toBeNull()
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled).toBe(
            false
        )
        expect(
            screen
                .getAllByRole<HTMLButtonElement>('button', { name: 'Download via Nexus' })
                .every((button) => !button.disabled)
        ).toBe(true)
    })

    it('shows ModWorkshop file installation in the header and permits retry after failure', async () => {
        const install = pending<InstallOutcome>()
        transport.installFile.mockReturnValueOnce(install.promise)
        showPage({ activeGame: 'pd3' })
        downloads()
        fireEvent.click(screen.getAllByRole('button', { name: /^Install ZIP/ })[0]!)
        await waitFor(() => expect(transport.installFile).toHaveBeenCalledTimes(1))
        expect(
            screen
                .getAllByRole<HTMLButtonElement>('button', { name: 'Preparing...' })
                .every((button) => button.disabled)
        ).toBe(true)
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: /^Install ZIP/ }).disabled
        ).toBe(true)

        await emit('download:progress', {
            download_id: 'file:340:13',
            game_id: 'pd3',
            downloaded: 1,
            total: 100,
        })
        expect(screen.getAllByRole<HTMLButtonElement>('button', { name: '1%' })).toHaveLength(2)
        fireEvent.click(screen.getAllByRole('button', { name: '1%' })[0]!)
        expect(transport.installMod).not.toHaveBeenCalled()
        await emit('download:finished', { download_id: 'file:340:13', game_id: 'pd3' })
        expect(
            screen.getAllByRole<HTMLButtonElement>('button', { name: 'Installing...' })
        ).toHaveLength(2)

        await act(async () => install.reject('Archive install failed'))
        expect(screen.getAllByText('Archive install failed').length).toBeGreaterThan(0)
        expect(screen.queryByText('1%')).toBeNull()
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled).toBe(
            false
        )

        const retry = pending<InstallOutcome>()
        transport.installFile.mockReturnValueOnce(retry.promise)
        fireEvent.click(screen.getAllByRole('button', { name: /^Install ZIP/ })[0]!)
        await waitFor(() => expect(transport.installFile).toHaveBeenCalledTimes(2))
        expect(screen.getAllByRole('button', { name: 'Preparing...' })).toHaveLength(2)
        expect(screen.queryByText('Archive install failed')).toBeNull()
        await act(async () => retry.resolve('installed'))
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled).toBe(
            false
        )
    })
})

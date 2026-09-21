import { GAMES } from '@modrex/games'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const store = new Map<string, string>()

beforeEach(() => {
    vi.resetModules()
    window.history.replaceState({}, '', '/')
    store.clear()
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

async function mount() {
    const { api } = await import('../src/api')
    const calls = {
        path: vi.spyOn(api, 'findGamePath'),
        installed: vi.spyOn(api, 'getInstalled'),
        settings: vi.spyOn(api, 'getGameSettings'),
        installs: vi.spyOn(api, 'getDetectedInstalls'),
        folders: vi.spyOn(api, 'listModFolders'),
        running: vi.spyOn(api, 'isGameRunning'),
        presence: vi.spyOn(api, 'updateDiscordPresence'),
        startup: vi.spyOn(api, 'reportStartupPhase'),
    }
    const { default: App } = await import('../src/App')
    const rendered = render(<App />)
    return { ...rendered, calls, api }
}

function sidebar() {
    return within(screen.getByRole('complementary'))
}

function expectNoGameCalls(calls: Awaited<ReturnType<typeof mount>>['calls']) {
    for (const name of [
        'path',
        'installed',
        'settings',
        'installs',
        'folders',
        'running',
    ] as const) {
        expect(calls[name], name).not.toHaveBeenCalled()
    }
}

function expectPickerDiscovery(calls: Awaited<ReturnType<typeof mount>>['calls']) {
    expect(calls.settings.mock.calls).toEqual(Object.keys(GAMES).map((gameId) => [gameId]))
    calls.settings.mockClear()
    expectNoGameCalls(calls)
}

test('first launch reaches the picker without loading a default game', async () => {
    const { calls } = await mount()
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
    await vi.waitFor(() => expect(calls.startup).toHaveBeenCalledWith('ready'))
    expectPickerDiscovery(calls)
    expect(calls.presence).toHaveBeenLastCalledWith('')
})

test('repeated settings clicks stay global and keep that scope after restart', async () => {
    store.set('modrex:active-game', 'pd2')
    store.set('modrex:on-welcome', '1')
    const { calls, unmount } = await mount()
    expectPickerDiscovery(calls)
    for (let click = 0; click < 3; click++) {
        fireEvent.click(sidebar().getByRole('button', { name: 'Settings' }))
        expect(await screen.findByRole('heading', { name: 'Language' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Game' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Launch without mods' })).toBeNull()
    }
    expectNoGameCalls(calls)
    expect(store.get('modrex:scope')).toBe('global-settings')
    expect(calls.presence).toHaveBeenCalledExactlyOnceWith('')
    unmount()
    vi.restoreAllMocks()
    const restarted = await mount()
    expect(await screen.findByRole('heading', { name: 'Language' })).toBeTruthy()
    expectNoGameCalls(restarted.calls)
    fireEvent.click(sidebar().getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
    expect(restarted.calls.presence).toHaveBeenCalledExactlyOnceWith('')
})

test('global advanced settings have no game folder actions', async () => {
    store.set('modrex:scope', 'global-settings')
    store.set('modrex:active-game', 'pd3')
    const { calls } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(await screen.findByRole('heading', { name: 'Folders' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open game folder' })).toBeNull()
    expectNoGameCalls(calls)
})

test('returning to the picker unmounts game pages and stops focus refreshes', async () => {
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'installed')
    const { calls } = await mount()
    await vi.waitFor(() => expect(calls.startup).toHaveBeenCalledWith('ready'))
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 3' }))
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Installed Mods' })).toBeNull()
    for (const call of Object.values(calls)) call.mockClear()
    fireEvent(window, new Event('focus'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    fireEvent.click(sidebar().getByRole('button', { name: 'Settings' }))
    fireEvent.click(sidebar().getByRole('button', { name: 'Settings' }))
    expectNoGameCalls(calls)
    expect(screen.queryByRole('button', { name: 'Game' })).toBeNull()
})

test('a delayed path lookup cannot continue loading a workspace after it closes', async () => {
    store.set('modrex:active-game', 'pd3')
    const { api } = await import('../src/api')
    let finishPath!: (value: string) => void
    vi.spyOn(api, 'findGamePath').mockImplementation(
        () =>
            new Promise((resolve) => {
                finishPath = resolve
            })
    )
    const { calls } = await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 3' }))
    await act(async () => {
        finishPath('C:\\PAYDAY 3')
    })
    expect(calls.installed).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
})

test('game settings belong to the selected game after leaving global settings', async () => {
    store.set('modrex:scope', 'global-settings')
    store.set('modrex:active-game', 'pd3')
    const { calls } = await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'PAYDAY 2' }))
    await vi.waitFor(() => expect(calls.path).toHaveBeenCalledWith('pd2'))
    fireEvent.click(sidebar().getByRole('button', { name: 'Settings' }))
    expect(
        await screen.findByText('C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 2')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Game' })).toBeTruthy()
    expect(calls.path).not.toHaveBeenCalledWith('pd3')
    expect(calls.presence.mock.calls).toEqual([[''], ['PAYDAY 2']])
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 2' }))
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
    expect(calls.presence.mock.calls).toEqual([[''], ['PAYDAY 2'], ['']])
})

test('an unknown remembered game opens the picker', async () => {
    store.set('modrex:active-game', 'removed-game')
    store.set('modrex:active-view', 'settings')
    const { calls } = await mount()
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeTruthy()
    expectPickerDiscovery(calls)
})

test('leaving game settings saves a pending launch-options edit', async () => {
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'settings')
    const { api } = await mount()
    await screen.findByText('C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3')
    const save = vi.spyOn(api, 'setLaunchOptions')
    fireEvent.change(screen.getByRole('textbox', { name: 'Launch Options' }), {
        target: { value: '-windowed' },
    })
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 3' }))
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('-windowed', 'pd3'))
})

test('a file-drop prompt keeps its original game after navigation', async () => {
    store.set('modrex:active-game', 'pd3')
    const { api } = await import('../src/api')
    let drop!: Parameters<typeof api.onFileDrop>[0]
    vi.spyOn(api, 'onFileDrop').mockImplementation((callback) => {
        drop = callback
        return () => {}
    })
    let finish!: (value: Awaited<ReturnType<typeof api.installDroppedFile>>) => void
    vi.spyOn(api, 'installDroppedFile').mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve
            })
    )
    const install = vi.spyOn(api, 'installFromZipEntry').mockResolvedValue(undefined)
    vi.spyOn(api, 'discardStagedArchive').mockResolvedValue(undefined)
    const { calls } = await mount()
    await vi.waitFor(() => expect(calls.startup).toHaveBeenCalledWith('ready'))
    act(() => drop({ type: 'drop', paths: ['C:\\example.zip'] }))
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'PAYDAY 2' }))
    await vi.waitFor(() => expect(calls.path).toHaveBeenCalledWith('pd2'))
    await act(async () =>
        finish({
            needsPicker: {
                archiveHandle: 'original-game-archive',
                entries: ['example.pak'],
                entryIds: [0],
                modId: 123,
                modName: 'Example',
                fileId: 456,
                fileType: 'zip',
                modVersion: '1',
                targetTag: null,
            },
        })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install Selected (1)' }))
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    expect(install.mock.calls[0]).toContain('pd3')
    expect(install.mock.calls[0]).toContain(
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3'
    )
    expect(install.mock.calls[0]).not.toContain('pd2')
})

test('file drops on global screens cannot install into a remembered game', async () => {
    store.set('modrex:scope', 'global-settings')
    store.set('modrex:active-game', 'pd3')
    const { api } = await import('../src/api')
    let drop!: Parameters<typeof api.onFileDrop>[0]
    vi.spyOn(api, 'onFileDrop').mockImplementation((callback) => {
        drop = callback
        return () => {}
    })
    const install = vi.spyOn(api, 'installDroppedFile')
    await mount()
    act(() => drop({ type: 'drop', paths: ['C:\\example.zip'] }))
    expect(install).not.toHaveBeenCalled()
})

test('changing language preserves the workspace and its game data', async () => {
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'installed')
    const { calls } = await mount()
    await vi.waitFor(() => expect(calls.startup).toHaveBeenCalledWith('ready'))
    calls.path.mockClear()
    calls.installed.mockClear()
    const { setLocale, t } = await import('../src/i18n')
    act(() => setLocale('de'))
    expect(await screen.findByRole('heading', { name: t('installed.title') })).toBeTruthy()
    expect(calls.path).not.toHaveBeenCalled()
    expect(calls.installed).not.toHaveBeenCalled()
})

test('reopening a game keeps its cached library while its path is rechecked', async () => {
    window.history.replaceState({}, '', '/?library=demo')
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'installed')
    const { calls, api } = await mount()
    expect(await screen.findByText('6 mods')).toBeTruthy()
    fireEvent.click(sidebar().getByRole('button', { name: 'PAYDAY 3' }))
    let finishPath!: (value: string) => void
    vi.spyOn(api, 'findGamePath').mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishPath = resolve
            })
    )
    calls.installed.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'PAYDAY 3' }))
    expect(await screen.findByText('6 mods')).toBeTruthy()
    expect(calls.installed).not.toHaveBeenCalled()
    await act(async () => {
        finishPath('C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3')
    })
    await vi.waitFor(() => expect(calls.installed).toHaveBeenCalledWith('pd3'))
})

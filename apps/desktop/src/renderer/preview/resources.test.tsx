import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ConfigFileLocation } from '../src/api'

const store = new Map<string, string>()
beforeEach(() => {
    vi.resetModules()
    window.history.replaceState({}, '', '/?library=resources')
    store.clear()
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'installed')
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
    const { default: App } = await import('../src/App')
    render(<App />)
    await screen.findByText('Custom intro movie')
    return api
}

test('installed resource recovery is contextual and cancellation preserves the installed entry', async () => {
    const { api } = await import('../src/api')
    const identify = vi.spyOn(api, 'identifyModViaNexusContent')
    await mount()
    expect(identify).not.toHaveBeenCalled()
    const review = vi.spyOn(api, 'reviewResourceRecovery')
    fireEvent.click(screen.getByRole('button', { name: 'Review files' }))
    const dialog = within(await screen.findByRole('dialog'))
    await dialog.findByText('Files that will be kept')
    expect(review).toHaveBeenCalledWith('pd3', 'resource:movie:changed')
    expect(dialog.getByRole('heading', { name: 'Custom intro movie' })).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Custom intro movie')).toBeTruthy()
})

test('game settings leave resource tools in the game-scoped Advanced tab', async () => {
    const api = await mount()
    const openIni = vi.spyOn(api, 'openEngineIni')
    fireEvent.click(
        within(screen.getByRole('complementary')).getByRole('button', { name: 'Settings' })
    )
    expect(await screen.findByRole('heading', { name: 'Launch Options' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(await screen.findByRole('heading', { name: 'PAYDAY 3 tools' })).toBeTruthy()
    expect(await screen.findByText('Engine.ini found.')).toBeTruthy()
    expect(screen.getByText(/C:\/Users\/Preview\/AppData\/Local\/PAYDAY3/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open INI' }))
    await vi.waitFor(() => expect(openIni).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Engine.ini' })).toBeNull()
})

test('a config-only declaration supplies settings tools without movie installation or scanning', async () => {
    store.set('modrex:active-game', 'pd2')
    const { GAMES } = await import('@modrex/games')
    const original = GAMES.pd2
    GAMES.pd2 = { ...original, configPresets: { filename: 'Engine.ini' } }
    try {
        const { default: App } = await import('../src/App')
        render(<App />)
        await screen.findByText('Small UI')
        expect(screen.queryByText('Custom intro movie')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Health Check' }))
        const dialog = within(await screen.findByRole('dialog'))
        fireEvent.mouseDown(dialog.getByRole('tab', { name: 'Game files' }))
        expect(dialog.getByText('No managed game files need attention.')).toBeTruthy()
        expect(dialog.queryByRole('button', { name: 'Check existing movies' })).toBeNull()
        fireEvent.click(dialog.getAllByRole('button', { name: 'Close' })[0])
        fireEvent.click(
            within(screen.getByRole('complementary')).getByRole('button', { name: 'Settings' })
        )
        fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
        expect(await screen.findByRole('heading', { name: 'PAYDAY 2 tools' })).toBeTruthy()
        expect(await screen.findByRole('button', { name: 'Choose Engine.ini' })).toBeTruthy()
    } finally {
        GAMES.pd2 = original
    }
})

test('a blocked-file banner routes to Installed instead of an absent interrupted operation', async () => {
    const { api } = await import('../src/api')
    const getInstalled = api.getInstalled.bind(api)
    vi.spyOn(api, 'getInstalled').mockImplementation(async (gameId) => {
        const response = await getInstalled(gameId)
        return {
            ...response,
            resourceError: 'Engine.ini exceeds the configuration limit',
            resourceRecoveryPending: false,
            mods: response.mods.map((mod) =>
                mod.uid === 'resource:movie:changed' ? { ...mod, resourceStatus: 'blocked' } : mod
            ),
        }
    })
    const review = vi.spyOn(api, 'reviewResourceRecovery')
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open Installed Mods' }))
    expect(review).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review files' }))
    await within(await screen.findByRole('dialog')).findByText('Files that will be kept')
    expect(review).toHaveBeenCalledExactlyOnceWith('pd3', 'resource:movie:changed')
})

test('an interrupted-operation banner opens the pending recovery directly', async () => {
    const { api } = await import('../src/api')
    const getInstalled = api.getInstalled.bind(api)
    vi.spyOn(api, 'getInstalled').mockImplementation(async (gameId) => ({
        ...(await getInstalled(gameId)),
        resourceError: 'An interrupted movie change is pending',
        resourceRecoveryPending: true,
    }))
    const review = vi.spyOn(api, 'reviewResourceRecovery').mockResolvedValue({
        reviewHandle: 'pending',
        gameId: 'pd3',
        deployments: ['Custom intro movie'],
        files: [],
    })
    await mount()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Review files' }))
    const dialog = within(await screen.findByRole('dialog'))
    await dialog.findByText('Files that will be kept')
    expect(review).toHaveBeenCalledExactlyOnceWith('pd3', null)
    expect(dialog.getByRole('heading', { name: 'Interrupted changes' })).toBeTruthy()
})

test('unreadable resource records do not offer a review without files to review', async () => {
    const { api } = await import('../src/api')
    const getInstalled = api.getInstalled.bind(api)
    vi.spyOn(api, 'getInstalled').mockImplementation(async (gameId) => {
        const response = await getInstalled(gameId)
        return {
            ...response,
            resourceError: 'Resource manifest is unreadable',
            resourceRecoveryPending: false,
            mods: response.mods.filter((mod) => !mod.deployment),
        }
    })
    const review = vi.spyOn(api, 'reviewResourceRecovery')
    const { default: App } = await import('../src/App')
    render(<App />)
    const alert = within(await screen.findByRole('alert'))
    expect(
        alert.getByText(
            'Modrex could not inspect movie or INI changes. Check the technical details before changing these files.'
        )
    ).toBeTruthy()
    expect(alert.getByText('Resource manifest is unreadable')).toBeTruthy()
    expect(alert.queryByRole('button')).toBeNull()
    expect(review).not.toHaveBeenCalled()
})

test('global Advanced settings do not inherit a previous game configuration shortcut', async () => {
    store.set('modrex:scope', 'global-settings')
    const { default: App } = await import('../src/App')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    await screen.findByRole('heading', { name: 'Folders' })
    expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open graphics config' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'PAYDAY 3 tools' })).toBeNull()
})

test.each([
    ['pd2', 'PAYDAY 2', 'renderer_settings_dx11.xml', 'PAYDAY 2'],
    ['pdth', 'PAYDAY: The Heist', 'renderer_settings.xml', 'PAYDAY'],
    ['raid', 'RAID: World War II', 'renderer_settings_dx11.xml', 'RAID WW2'],
])(
    'opens graphics configuration in game Advanced settings for %s',
    async (gameId, name, filename, folder) => {
        store.set('modrex:active-game', gameId)
        const { api } = await import('../src/api')
        const open = vi.spyOn(api, 'openGraphicsConfig')
        const { default: App } = await import('../src/App')
        render(<App />)
        await screen.findByRole('button', { name: 'Launch without mods' })
        fireEvent.click(
            within(screen.getByRole('complementary')).getByRole('button', { name: 'Settings' })
        )
        await screen.findByRole('heading', { name: 'Launch Options' })
        expect(screen.queryByRole('button', { name: 'Open graphics config' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
        await screen.findByRole('heading', { name: `${name} tools` })
        await screen.findByText(`${filename} found.`)
        expect(
            screen.getByText(`C:/Users/Preview/AppData/Local/${folder}/${filename}`)
        ).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Open saved copies' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Open graphics config' }))
        await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(gameId))
        expect(screen.queryByRole('dialog')).toBeNull()
    }
)

test('Health Check offers a read-only movie scan', async () => {
    const api = await mount()
    const scan = vi.spyOn(api, 'inspectMovieResources')
    fireEvent.click(screen.getByRole('button', { name: 'Health Check' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('tab', { name: 'Game files' }).getAttribute('aria-selected')).toBe(
        'true'
    )
    fireEvent.mouseDown(dialog.getByRole('tab', { name: 'Game files' }))
    fireEvent.click(await dialog.findByRole('button', { name: 'Check existing movies' }))
    await dialog.findByText(
        'The mod database does not include movie identification data, so this check could not identify movie mods.'
    )
    expect(dialog.queryByText('StartUp_SBZ.bk2')).toBeNull()
    expect(scan).toHaveBeenCalledExactlyOnceWith('pd3')
    fireEvent.click(dialog.getByRole('button', { name: 'Clear results' }))
    expect(dialog.queryByRole('status')).toBeNull()
    expect(dialog.getByRole('button', { name: 'Check existing movies' })).toBeTruthy()
})

test('does not complete a graphics-file handoff after the installation store changes', async () => {
    store.set('modrex:active-game', 'pd2')
    const { api } = await import('../src/api')
    let resolvePrevious!: (location: ConfigFileLocation) => void
    vi.spyOn(api, 'getGraphicsConfigLocation')
        .mockResolvedValueOnce({ status: 'found', path: 'G:/Old/renderer_settings_dx11.xml' })
        .mockReturnValueOnce(
            new Promise((resolve) => {
                resolvePrevious = resolve
            })
        )
        .mockResolvedValue({ status: 'needsLocation' })
    const open = vi.spyOn(api, 'openGraphicsConfig')
    const { default: App } = await import('../src/App')
    render(<App />)
    await screen.findByRole('button', { name: 'Launch without mods' })
    fireEvent.click(
        within(screen.getByRole('complementary')).getByRole('button', { name: 'Settings' })
    )
    await screen.findByRole('heading', { name: 'Launch Options' })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open graphics config' }))
    const { patchSettingsCache } = await import('../src/settingsCache')
    const { refreshGamePath } = await import('../src/gameData')
    await act(async () => {
        patchSettingsCache('pd2', { launcher: 'manual' })
        await refreshGamePath('pd2')
    })
    await screen.findByRole('button', { name: 'Choose renderer_settings_dx11.xml' })
    await act(async () =>
        resolvePrevious({ status: 'found', path: 'G:/Old/renderer_settings_dx11.xml' })
    )
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByText('G:/Old/renderer_settings_dx11.xml')).toBeNull()
})

test('Health Check opens recovery storage through its dedicated command', async () => {
    const api = await mount()
    const open = vi.spyOn(api, 'openResourceRecoveryFolder')
    const openData = vi.spyOn(api, 'openDataFolder')
    fireEvent.click(screen.getByRole('button', { name: 'Health Check' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Open recovery folder' }))
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(openData).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GameId } from '../../shared/types'

const mocks = vi.hoisted(() => ({
    findGamePath: vi.fn(),
    getInstalled: vi.fn(),
    log: vi.fn(),
    refresh: new Map<string, () => Promise<void>>(),
}))

vi.mock('./api', () => ({
    api: { findGamePath: mocks.findGamePath, getInstalled: mocks.getInstalled },
}))
vi.mock('@tauri-apps/plugin-log', () => ({ error: mocks.log }))
vi.mock('./sources', () => ({ sourcesForGame: () => [], hasSource: () => false }))
vi.mock('./i18n', () => ({ useLocale: () => 'en', t: (key: string) => key }))
vi.mock('./settingsCache', () => ({
    getSettingsCache: () => ({ settings: { launcher: 'steam' } }),
}))
vi.mock('./lib/analytics/useModIdentificationTracking', () => ({
    useModIdentificationTracking: () => {},
}))
vi.mock('./components/FileDropInstall', () => ({ useFileDropTarget: () => {} }))
vi.mock('./components/GameTopBar', () => ({ GameTopBar: () => null }))
vi.mock('./components/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./components/BrowsePage', () => ({ BrowsePage: () => null }))
vi.mock('./components/NexusBrowsePage', () => ({ NexusBrowsePage: () => null }))
vi.mock('./components/NewsPage', () => ({ NewsPage: () => null }))
vi.mock('./components/ModDetailPage', () => ({ ModDetailPage: () => null }))
vi.mock('./components/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('./components/GameSettings', () => ({ GameSettings: () => null }))
vi.mock('./components/GameFolders', () => ({ GameFolders: () => null }))
vi.mock('./components/EngineIniSettings', () => ({ EngineIniSettings: () => null }))
vi.mock('./components/GraphicsConfigSettings', () => ({ GraphicsConfigSettings: () => null }))
vi.mock('./components/ResourceRecoveryDialog', () => ({ ResourceRecoveryDialog: () => null }))
vi.mock('./components/InstalledPage', () => ({
    InstalledPage: ({
        activeGame,
        installedReady,
        onRefreshInstalled,
    }: {
        activeGame: GameId
        installedReady: boolean
        onRefreshInstalled: () => Promise<void>
    }) => {
        mocks.refresh.set(activeGame, onRefreshInstalled)
        return <span>{installedReady ? 'Installed list ready' : 'Installed list loading'}</span>
    },
}))

const installed = {
    mods: [],
    folders: [],
    modsHidden: false,
    stateUnreadable: false,
    resourceError: null,
    resourceRecoveryPending: false,
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

async function mountGame(activeGame: GameId = 'pd3') {
    const { GameWorkspace } = await import('./GameWorkspace')
    const phase = vi.fn()
    const view = render(
        <GameWorkspace
            activeGame={activeGame}
            onShowWelcome={vi.fn()}
            settings={{
                analyticsConsent: false,
                onAnalyticsConsent: vi.fn(),
                discordPresenceEnabled: false,
                onDiscordPresenceEnabled: vi.fn(),
            }}
            topBar={{}}
            banners={null}
            onStartupPhase={phase}
        />
    )
    return { ...view, phase }
}

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.refresh.clear()
    localStorage.clear()
    mocks.findGamePath.mockResolvedValue('C:/game')
    mocks.getInstalled.mockResolvedValue(installed)
})

afterEach(cleanup)

it('clears a failed initial scan after an explicit successful refresh', async () => {
    mocks.getInstalled.mockRejectedValueOnce(new Error('Steam update in progress'))
    await mountGame()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Steam update'))
    expect(screen.getByText('Installed list loading')).toBeTruthy()

    await act(async () => mocks.refresh.get('pd3')!())

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Installed list ready')).toBeTruthy()
})

it('shows a failed explicit refresh and rejects the same error to its caller', async () => {
    await mountGame()
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    const error = new Error('Steam catalog missing')
    mocks.getInstalled.mockRejectedValueOnce(error)

    await act(async () => {
        await expect(mocks.refresh.get('pd3')!()).rejects.toBe(error)
    })

    expect(screen.getByRole('alert').textContent).toContain('Steam catalog missing')
    expect(screen.getByText('Installed list ready')).toBeTruthy()
})

it('does not let an older successful refresh clear a newer failure', async () => {
    const { phase } = await mountGame()
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    phase.mockClear()
    const older = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(older.promise)
    const pending = mocks.refresh.get('pd3')!()
    mocks.getInstalled.mockRejectedValueOnce(new Error('Newer catalog failure'))

    await act(async () => {
        await expect(mocks.refresh.get('pd3')!()).rejects.toThrow('Newer catalog failure')
        older.resolve(installed)
        await pending
    })

    expect(screen.getByRole('alert').textContent).toContain('Newer catalog failure')
    expect(phase.mock.calls).toEqual([['error']])
})

it('does not let an older failed refresh replace a newer success', async () => {
    const { phase } = await mountGame()
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    phase.mockClear()
    const older = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(older.promise)
    const pending = mocks.refresh.get('pd3')!()

    await act(async () => {
        await mocks.refresh.get('pd3')!()
        older.reject(new Error('Old catalog failure'))
        await expect(pending).rejects.toThrow('Old catalog failure')
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(phase.mock.calls).toEqual([['ready']])
})

it('does not let an older mount scan clear a newer explicit failure', async () => {
    const initial = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(initial.promise)
    const { phase } = await mountGame()
    await waitFor(() => expect(mocks.getInstalled).toHaveBeenCalledOnce())
    mocks.getInstalled.mockRejectedValueOnce(new Error('Newer catalog failure'))

    await act(async () => {
        await expect(mocks.refresh.get('pd3')!()).rejects.toThrow('Newer catalog failure')
        initial.resolve(installed)
        await initial.promise
    })

    expect(screen.getByRole('alert').textContent).toContain('Newer catalog failure')
    expect(phase).not.toHaveBeenCalledWith('ready')
    expect(phase).toHaveBeenLastCalledWith('error')
})

it('does not let an older mount failure replace a newer explicit success', async () => {
    const initial = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(initial.promise)
    const { phase } = await mountGame()
    await waitFor(() => expect(mocks.getInstalled).toHaveBeenCalledOnce())

    await act(async () => {
        await mocks.refresh.get('pd3')!()
        initial.reject(new Error('Old catalog failure'))
        await expect(initial.promise).rejects.toThrow('Old catalog failure')
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(phase).toHaveBeenLastCalledWith('ready')
    expect(phase).not.toHaveBeenCalledWith('error')
    expect(mocks.log).not.toHaveBeenCalled()
})

it('clears a scan failure when returning to Modrex triggers a successful focus refresh', async () => {
    mocks.getInstalled.mockRejectedValueOnce(new Error('Steam update in progress'))
    await mountGame()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.focus(window)

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(mocks.getInstalled).toHaveBeenCalledTimes(2)
})

it('ignores a closed workspace scan when another game is opened', async () => {
    const initial = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(initial.promise)
    const first = await mountGame('pd3')
    await waitFor(() => expect(mocks.getInstalled).toHaveBeenCalledOnce())
    first.unmount()
    const second = await mountGame('ron')
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())

    await act(async () => {
        initial.reject(new Error('Closed game catalog failure'))
        await expect(initial.promise).rejects.toThrow('Closed game catalog failure')
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(first.phase).not.toHaveBeenCalledWith('error')
    expect(second.phase).toHaveBeenCalledWith('ready')
    expect(mocks.getInstalled.mock.calls.map(([gameId]) => gameId)).toEqual(['pd3', 'ron'])
})

it('refreshes a closed game cache without completing another workspace startup', async () => {
    const first = await mountGame('pd3')
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    const refreshClosedGame = mocks.refresh.get('pd3')!
    first.unmount()
    first.phase.mockClear()
    const pending = deferred<typeof installed>()
    mocks.getInstalled.mockReturnValueOnce(pending.promise)
    const second = await mountGame('ron')
    await waitFor(() => expect(mocks.getInstalled).toHaveBeenCalledTimes(2))
    const updated = { ...installed, modsHidden: true }
    mocks.getInstalled.mockResolvedValueOnce(updated)

    await act(async () => refreshClosedGame())

    const { getGameData } = await import('./gameData')
    expect(getGameData('pd3').installed).toEqual(updated)
    expect(first.phase).not.toHaveBeenCalled()
    expect(second.phase).not.toHaveBeenCalledWith('ready')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => {
        pending.resolve(installed)
        await pending.promise
    })
    expect(second.phase).toHaveBeenLastCalledWith('ready')
})

it('rejects a refresh invoked after unmount without reporting a closed workspace error', async () => {
    const first = await mountGame('pd3')
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    const refreshClosedGame = mocks.refresh.get('pd3')!
    first.unmount()
    first.phase.mockClear()
    const second = await mountGame('ron')
    await waitFor(() => expect(screen.getByText('Installed list ready')).toBeTruthy())
    second.phase.mockClear()
    const error = new Error('Closed game catalog failure')
    mocks.getInstalled.mockRejectedValueOnce(error)

    await act(async () => {
        await expect(refreshClosedGame()).rejects.toBe(error)
    })

    expect(first.phase).not.toHaveBeenCalled()
    expect(second.phase).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
})

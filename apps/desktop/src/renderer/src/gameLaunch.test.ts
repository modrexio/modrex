import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({
    getGameLaunchStatus: vi.fn(),
    cancelPendingGameLaunch: vi.fn(),
    launchWithoutMods: vi.fn(),
    launchModded: vi.fn(),
    restoreMods: vi.fn(),
    stopGame: vi.fn(),
}))
const refreshInstalled = vi.hoisted(() => vi.fn())
const logError = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api }))
vi.mock('./gameData', () => ({ refreshInstalled }))
vi.mock('@tauri-apps/plugin-log', () => ({ error: logError }))

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    api.cancelPendingGameLaunch.mockResolvedValue(undefined)
    api.launchWithoutMods.mockResolvedValue(null)
    api.launchModded.mockResolvedValue(null)
    api.restoreMods.mockResolvedValue(undefined)
    refreshInstalled.mockResolvedValue(undefined)
})
afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
})

test('a vanilla launch restores its game after its screen is closed', async () => {
    const launch = await import('./gameLaunch')
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    await launch.launchGame('pd3', 'vanilla')
    unsubscribe()
    api.getGameLaunchStatus.mockResolvedValue({ running: true, pending: null })
    await vi.advanceTimersByTimeAsync(3000)
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.restoreMods).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(vi.getTimerCount()).toBe(0)
})

test('leaving while the launch command is pending preserves restoration', async () => {
    const launch = await import('./gameLaunch')
    let finish!: (value: null) => void
    api.launchWithoutMods.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve
            })
    )
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    const pending = launch.launchGame('pd3', 'vanilla')
    unsubscribe()
    const closeOther = launch.subscribeLaunchState('pd2', vi.fn())
    api.getGameLaunchStatus.mockImplementation(async (game: string) => ({
        running: game === 'pd3',
        pending: null,
    }))
    await vi.advanceTimersByTimeAsync(3000)
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.restoreMods).not.toHaveBeenCalled()
    finish(null)
    await pending
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.restoreMods).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(launch.getLaunchState('pd2').error).toBeNull()
    closeOther()
})

test('closing an idle game stops process polling', async () => {
    const launch = await import('./gameLaunch')
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    unsubscribe()
    api.getGameLaunchStatus.mockClear()
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.getGameLaunchStatus).not.toHaveBeenCalled()
})

test('a failed restoration remains visible for the original game', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: true, pending: null })
    await vi.advanceTimersByTimeAsync(3000)
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    api.restoreMods.mockRejectedValue(new Error('Files are locked'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(launch.getLaunchState('pd3').error).toBe('Error: Files are locked')
    expect(launch.getLaunchState('pd2').error).toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Files are locked'))
})

test('keeps a handed-off launch pending beyond a minute and across screen changes', async () => {
    const launch = await import('./gameLaunch')
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    await launch.launchGame('pd3', 'modded')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(launch.getLaunchState('pd3')).toMatchObject({
        running: false,
        launching: 'modded',
        pending: 'handedOff',
    })
    unsubscribe()
    api.getGameLaunchStatus.mockClear()
    const closeOther = launch.subscribeLaunchState('pd2', vi.fn())
    api.getGameLaunchStatus.mockImplementation(async (game: string) => ({
        running: false,
        pending: game === 'pd3' ? 'handedOff' : null,
    }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getGameLaunchStatus).toHaveBeenCalledWith('pd3')
    expect(launch.getLaunchState('pd2').pending).toBeNull()
    expect(launch.getLaunchState('pd3').pending).toBe('handedOff')
    closeOther()
})

test('a status failure preserves the pending launch and its polling', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'modded')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    api.getGameLaunchStatus.mockRejectedValueOnce(new Error('Process inspection failed'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(launch.getLaunchState('pd3')).toMatchObject({
        pending: 'handedOff',
        launching: 'modded',
        error: 'Error: Process inspection failed',
    })
    api.getGameLaunchStatus.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getGameLaunchStatus).toHaveBeenCalledExactlyOnceWith('pd3')
})

test('restores vanilla folders after another observer has cleared the launch marker', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.restoreMods).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(vi.getTimerCount()).toBe(0)
})

test('discards a status response taken before a new launch began', async () => {
    const launch = await import('./gameLaunch')
    let resolveOld!: (status: { running: boolean; pending: null }) => void
    api.getGameLaunchStatus.mockReturnValueOnce(
        new Promise((resolve) => {
            resolveOld = resolve
        })
    )
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    resolveOld({ running: false, pending: null })
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(launch.getLaunchState('pd3').pending).toBe('handedOff')
    unsubscribe()
})

test('resets only after native success without repeating native folder restoration', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    await launch.resetPendingLaunch('pd3')
    expect(api.cancelPendingGameLaunch).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(launch.getLaunchState('pd3')).toMatchObject({ pending: null, launching: null })
    expect(vi.getTimerCount()).toBe(0)
})

test('waits for a delayed reset before applying idle status or restoring folders', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    let finish!: () => void
    api.cancelPendingGameLaunch.mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            })
    )
    const reset = launch.resetPendingLaunch('pd3')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    await vi.advanceTimersByTimeAsync(6000)
    expect(launch.getLaunchState('pd3')).toMatchObject({
        launching: 'vanilla',
        pending: 'handedOff',
    })
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(refreshInstalled).not.toHaveBeenCalled()
    await expect(launch.resetPendingLaunch('pd3')).rejects.toThrow('Wait for it to finish')
    await expect(launch.launchGame('pd3', 'modded')).resolves.toBeUndefined()
    expect(launch.getLaunchState('pd3').error).toContain('Wait for it to finish')
    finish()
    await reset
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.cancelPendingGameLaunch).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.launchModded).not.toHaveBeenCalled()
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(launch.getLaunchState('pd3')).toMatchObject({ pending: null, launching: null })
    expect(vi.getTimerCount()).toBe(0)
})

test.each(['launch failure', 'successful reset'] as const)(
    'reports a launch clicked during delayed refresh after %s without rejecting',
    async (operation) => {
        const launch = await import('./gameLaunch')
        if (operation === 'successful reset') {
            await launch.launchGame('pd3', 'vanilla')
            api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
            await vi.advanceTimersByTimeAsync(3000)
        }
        let finishRefresh!: () => void
        refreshInstalled.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishRefresh = resolve
                })
        )
        api.launchWithoutMods.mockRejectedValue(new Error('Launcher failed'))
        const pending =
            operation === 'successful reset'
                ? launch.resetPendingLaunch('pd3')
                : launch.launchGame('pd3', 'vanilla')
        api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
        await vi.advanceTimersByTimeAsync(0)
        expect(launch.getLaunchState('pd3')).toMatchObject({ pending: null, launching: null })
        await expect(launch.launchGame('pd3', 'modded')).resolves.toBeUndefined()
        expect(api.launchModded).not.toHaveBeenCalled()
        expect(launch.getLaunchState('pd3').error).toContain('Wait for it to finish')
        expect(launch.getLaunchState('pd2').error).toBeNull()
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('Wait for it to finish'))
        await vi.advanceTimersByTimeAsync(3000)
        expect(api.restoreMods).not.toHaveBeenCalled()
        finishRefresh()
        await pending
        await vi.advanceTimersByTimeAsync(6000)
        expect(api.restoreMods).not.toHaveBeenCalled()
        expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    }
)

test('does not expose handoff or allow reset before the launch response settles', async () => {
    const launch = await import('./gameLaunch')
    let finish!: (value: null) => void
    api.launchWithoutMods.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve
            })
    )
    const pendingLaunch = launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    const unsubscribe = launch.subscribeLaunchState('pd3', vi.fn())
    await vi.advanceTimersByTimeAsync(6000)
    expect(launch.getLaunchState('pd3')).toMatchObject({
        launching: 'vanilla',
        pending: 'preparing',
    })
    await expect(launch.resetPendingLaunch('pd3')).rejects.toThrow('Wait for it to finish')
    expect(api.cancelPendingGameLaunch).not.toHaveBeenCalled()
    finish(null)
    await pendingLaunch
    await vi.advanceTimersByTimeAsync(3000)
    expect(launch.getLaunchState('pd3').pending).toBe('handedOff')
    await launch.resetPendingLaunch('pd3')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: null })
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.cancelPendingGameLaunch).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(launch.getLaunchState('pd3')).toMatchObject({ pending: null, launching: null })
    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
})

test('a failed reset keeps the pending marker and refreshes partially restored folders', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    api.cancelPendingGameLaunch.mockRejectedValue(new Error('Files are locked'))
    await expect(launch.resetPendingLaunch('pd3')).rejects.toThrow('Files are locked')
    expect(launch.getLaunchState('pd3')).toMatchObject({
        pending: 'handedOff',
        launching: 'vanilla',
        error: 'Error: Files are locked',
    })
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(launch.getLaunchState('pd2').error).toBeNull()
    refreshInstalled.mockRejectedValueOnce(new Error('List unavailable'))
    await expect(launch.resetPendingLaunch('pd3')).rejects.toBe(
        'Error: Files are locked\nError: List unavailable'
    )
    expect(launch.getLaunchState('pd3').pending).toBe('handedOff')
})

test('a refresh failure after successful reset does not repeat native recovery', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    refreshInstalled.mockRejectedValueOnce(new Error('List unavailable'))
    await expect(launch.resetPendingLaunch('pd3')).resolves.toBeUndefined()
    expect(launch.getLaunchState('pd3')).toMatchObject({
        pending: null,
        launching: null,
        error: 'Error: List unavailable',
    })
    expect(api.cancelPendingGameLaunch).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

test('a status response from before reset cannot recreate the pending marker', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'modded')
    api.getGameLaunchStatus.mockResolvedValue({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(3000)
    let resolveOld!: (status: { running: boolean; pending: 'handedOff' }) => void
    api.getGameLaunchStatus.mockReturnValueOnce(
        new Promise((resolve) => {
            resolveOld = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(3000)
    await launch.resetPendingLaunch('pd3')
    resolveOld({ running: false, pending: 'handedOff' })
    await vi.advanceTimersByTimeAsync(0)
    expect(launch.getLaunchState('pd3').pending).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
})

test('refreshes folder state after native launch failure without restoring it again', async () => {
    const launch = await import('./gameLaunch')
    api.launchWithoutMods.mockRejectedValue(new Error('Launcher failed'))
    await launch.launchGame('pd3', 'vanilla')
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.restoreMods).not.toHaveBeenCalled()
    expect(launch.getLaunchState('pd3')).toMatchObject({
        error: 'Error: Launcher failed',
        launching: null,
    })
})

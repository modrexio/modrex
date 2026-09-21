import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({
    isGameRunning: vi.fn(),
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
    api.isGameRunning.mockResolvedValue(false)
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
    api.isGameRunning.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(3000)
    api.isGameRunning.mockResolvedValue(false)
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
    api.isGameRunning.mockImplementation(async (game: string) => game === 'pd3')
    await vi.advanceTimersByTimeAsync(3000)
    api.isGameRunning.mockResolvedValue(false)
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
    api.isGameRunning.mockClear()
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.isGameRunning).not.toHaveBeenCalled()
})

test('a failed restoration remains visible for the original game', async () => {
    const launch = await import('./gameLaunch')
    await launch.launchGame('pd3', 'vanilla')
    api.isGameRunning.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(3000)
    api.isGameRunning.mockResolvedValue(false)
    api.restoreMods.mockRejectedValue(new Error('Files are locked'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(launch.getLaunchState('pd3').error).toBe('Error: Files are locked')
    expect(launch.getLaunchState('pd2').error).toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Files are locked'))
})

import { beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ findGamePath: vi.fn(), getInstalled: vi.fn() }))
vi.mock('./api', () => ({ api }))

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
})

test('a late installed response cannot replace a newer result for the same game', async () => {
    const data = await import('./gameData')
    let finish!: (value: unknown) => void
    api.getInstalled.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve
            })
    )
    const old = data.refreshInstalled('pd3')
    const current = { mods: [], folders: [], modsHidden: true, stateUnreadable: false }
    api.getInstalled.mockResolvedValueOnce(current)
    await data.refreshInstalled('pd3')
    finish({ ...current, modsHidden: false })
    await old
    expect(data.getGameData('pd3').installed).toEqual(current)
})

test('refreshes notify only the game they belong to', async () => {
    const data = await import('./gameData')
    const pd3 = vi.fn()
    const pd2 = vi.fn()
    data.subscribeGameData('pd3', pd3)
    data.subscribeGameData('pd2', pd2)
    api.getInstalled.mockResolvedValue({
        mods: [],
        folders: [],
        modsHidden: false,
        stateUnreadable: false,
    })
    await data.refreshInstalled('pd3')
    expect(pd3).toHaveBeenCalledOnce()
    expect(pd2).not.toHaveBeenCalled()
    expect(data.getGameData('pd2').installed).toBeUndefined()
})

test('a failed refresh keeps cached data and rejects the error', async () => {
    const data = await import('./gameData')
    const cached = { mods: [], folders: [], modsHidden: true, stateUnreadable: false }
    api.getInstalled.mockResolvedValueOnce(cached)
    await data.refreshInstalled('pd3')
    api.getInstalled.mockRejectedValueOnce(new Error('Cannot read state'))
    await expect(data.refreshInstalled('pd3')).rejects.toThrow('Cannot read state')
    expect(data.getGameData('pd3').installed).toBe(cached)
})

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    events: new Map<string, (event: { payload: unknown }) => void>(),
    commands: {
        installMod: vi.fn(),
        installFile: vi.fn(),
        installFromZipEntry: vi.fn(),
        installConfirmedLoader: vi.fn(),
        discardStagedArchive: vi.fn(),
        shellOpenExternal: vi.fn(),
        recordSuccessfulInstall: vi.fn(),
        getInstalled: vi.fn(),
    },
    logError: vi.fn(),
}))

vi.mock('../../shared/bindings', () => ({ commands: mocks.commands }))
vi.mock('@tauri-apps/plugin-log', () => ({ error: mocks.logError }))
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
        mocks.events.set(name, callback)
        return () => mocks.events.delete(name)
    }),
}))

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.events.clear()
    mocks.commands.getInstalled.mockResolvedValue({ mods: [], folders: [], modsHidden: false })
    mocks.commands.recordSuccessfulInstall.mockResolvedValue(undefined)
    mocks.commands.shellOpenExternal.mockResolvedValue(undefined)
    mocks.commands.discardStagedArchive.mockResolvedValue(undefined)
    mocks.commands.installFromZipEntry.mockResolvedValue(undefined)
    mocks.commands.installConfirmedLoader.mockResolvedValue(undefined)
})

afterEach(() => vi.useRealTimers())

function emit(name: string, payload: unknown) {
    const callback = mocks.events.get(name)
    expect(callback).toBeDefined()
    callback!({ payload })
}

test('finished download switches from bytes to installation until the command completes', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    api.observeInstalls()
    let finish!: (outcome: string) => void
    mocks.commands.installMod.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve
            })
    )
    const installing = api.installMod(12, 'game', 'pd3')
    emit('download:progress', {
        download_id: 'mod:12',
        game_id: 'pd3',
        downloaded: 100,
        total: 100,
    })
    expect(state.installLabel(state.getInstallOperations('pd3')[0]!)).toBe('100%')
    emit('download:finished', { download_id: 'mod:12', game_id: 'pd3' })
    expect(state.getInstallOperations('pd3')[0]!.phase).toBe('installing')
    expect(state.installProgress(state.getInstallOperations('pd3')[0])).toBeNull()
    finish('installed')
    await installing
    expect(mocks.commands.getInstalled).toHaveBeenCalledWith('pd3')
    expect(state.getInstallOperations('pd3')).toEqual([])
})

test('Nexus byte progress and failures cannot change another game with matching remote ids', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    api.observeInstalls()
    emit('nxm:install-started', { gameId: 'ron', modId: 12, fileId: 34 })
    emit('nxm:install-started', { gameId: 'pd3', modId: 12, fileId: 34 })
    emit('download:progress', {
        download_id: 'nxm:ron:12:34',
        game_id: 'ron',
        downloaded: 5,
        total: 0,
    })
    expect(state.getInstallOperations('ron')[0]!.phase).toBe('downloading')
    expect(state.getInstallOperations('pd3')[0]!.phase).toBe('preparing')
    emit('nxm:install-failed', { gameId: 'ron', modId: 12, fileId: 34, message: 'Expired link' })
    expect(state.getInstallOperations('ron')[0]!.error).toBe('Expired link')
    expect(state.getInstallOperations('pd3')[0]!.phase).toBe('preparing')
    emit('nxm:install-failed', { gameId: null, modId: null, fileId: null, message: 'Invalid URL' })
    expect(state.getInstallOperations('pd3')[0]!.phase).toBe('preparing')
    expect(mocks.logError).toHaveBeenCalledWith('Nexus handoff failed: Invalid URL')
})

test('selected files of one ModWorkshop mod keep independent progress and completion', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    api.observeInstalls()
    const finish: ((outcome: 'installed') => void)[] = []
    mocks.commands.installMod.mockImplementation(
        () => new Promise<'installed'>((resolve) => finish.push(resolve))
    )
    const first = api.installMod(12, 'game', 'pd3', 34)
    const second = api.installMod(12, 'game', 'pd3', 35)
    emit('download:progress', {
        game_id: 'pd3',
        download_id: 'file:12:34',
        downloaded: 20,
        total: 100,
    })
    emit('download:progress', {
        game_id: 'pd3',
        download_id: 'file:12:35',
        downloaded: 70,
        total: 100,
    })
    expect(
        state.installProgress(
            state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12, 34)
        )
    ).toEqual({ downloaded: 20, total: 100 })
    expect(
        state.installProgress(
            state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12, 35)
        )
    ).toEqual({ downloaded: 70, total: 100 })
    emit('download:finished', { game_id: 'pd3', download_id: 'file:12:34' })
    expect(
        state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12, 34)?.phase
    ).toBe('installing')
    expect(
        state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12, 35)?.phase
    ).toBe('downloading')
    finish[0]!('installed')
    await first
    expect(state.getInstallOperations('pd3').map((operation) => operation.target.fileId)).toEqual([
        35,
    ])
    finish[1]!('installed')
    await second
    expect(state.getInstallOperations('pd3')).toEqual([])
})

test('browser waiting expires while an accepted Nexus handoff survives the same timeout', async () => {
    vi.useFakeTimers()
    const { api } = await import('./api')
    const state = await import('./installState')
    api.observeInstalls()
    await api.requestNexusDownload('ron', 12, 'https://example.com/12')
    await api.requestNexusDownload('ron', 13, 'https://example.com/13')
    emit('nxm:install-started', { gameId: 'ron', modId: 12, fileId: 34 })
    vi.advanceTimersByTime(180_000)
    expect(state.getInstallOperations('ron')).toHaveLength(1)
    expect(state.getInstallOperations('ron')[0]!.target.modId).toBe(12)
    expect(state.getInstallOperations('ron')[0]!.phase).toBe('preparing')
})

test('ordinary prompts stay active across multiple archive entries and end on discard', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    mocks.commands.installMod.mockResolvedValueOnce({ needsPicker: { archiveHandle: 'archive' } })
    const outcome = await api.installMod(12, 'game', 'pd3')
    expect(outcome).toEqual({ needsPicker: { archiveHandle: 'archive' } })
    expect(state.getArchiveInstall('archive')?.phase).toBe('review')
    await api.installFromZipEntry('archive', 0, 12, 'Mod', 34, 'zip', '1', 'game', 'pd3')
    expect(state.getArchiveInstall('archive')?.phase).toBe('review')
    await api.installFromZipEntry('archive', 1, 12, 'Mod', 34, 'zip', '1', 'game', 'pd3')
    expect(state.getArchiveInstall('archive')?.phase).toBe('review')
    await api.discardStagedArchive('archive')
    expect(state.getInstallOperations('pd3')).toEqual([])
})

test('a rejected command retains scoped feedback and blocks no retry', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    mocks.commands.installMod.mockRejectedValueOnce(new Error('Cannot download'))
    await expect(api.installMod(12, 'game', 'pd3')).rejects.toThrow('Cannot download')
    expect(state.getInstallOperations('pd3')[0]!.phase).toBe('failed')
    expect(state.getInstallOperations('pd3')[0]!.error).toBe('Error: Cannot download')
    mocks.commands.installMod.mockResolvedValueOnce('installed')
    await api.installMod(12, 'game', 'pd3')
    expect(state.getInstallOperations('pd3')).toEqual([])
})

test('rejecting an unsupported prompt reports cleanup failure without keeping the mod busy', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    const { rejectInstallPrompt } = await import('./installSentinels')
    mocks.commands.installMod.mockResolvedValueOnce({ needsPicker: { archiveHandle: 'archive' } })
    const outcome = await api.installMod(12, 'game', 'pd3')
    mocks.commands.discardStagedArchive.mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(rejectInstallPrompt(outcome)).rejects.toThrow('cleanup unavailable')
    const operation = state.getArchiveInstall('archive')
    expect(operation?.error).toBe('Error: cleanup unavailable')
    expect(state.isInstallBusy(operation)).toBe(false)
})

test('a failed archive entry remains reviewable and retry clears its scoped error', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    mocks.commands.installMod.mockResolvedValueOnce({ needsPicker: { archiveHandle: 'archive' } })
    await api.installMod(12, 'game', 'pd3')
    mocks.commands.installFromZipEntry.mockRejectedValueOnce(new Error('Cannot extract'))
    await expect(
        api.installFromZipEntry('archive', 0, 12, 'Mod', 34, 'zip', '1', 'game', 'pd3')
    ).rejects.toThrow('Cannot extract')
    expect(state.getArchiveInstall('archive')?.phase).toBe('review')
    expect(state.getArchiveInstall('archive')?.error).toBe('Error: Cannot extract')
    await api.installFromZipEntry('archive', 0, 12, 'Mod', 34, 'zip', '1', 'game', 'pd3')
    expect(state.getArchiveInstall('archive')?.error).toBeUndefined()
})

test('a confirmed loader consumes its archive and completes after the installed refresh', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    mocks.commands.installMod.mockResolvedValueOnce({
        needsLoaderConfirm: { archiveHandle: 'archive' },
    })
    await api.installMod(12, 'game', 'pd3')
    await api.installConfirmedLoader('archive', 'pd3', 'game', null)
    expect(mocks.commands.getInstalled).toHaveBeenCalledWith('pd3')
    expect(state.getArchiveInstall('archive')).toBeUndefined()
    expect(mocks.commands.discardStagedArchive).not.toHaveBeenCalled()
})

test('duplicate clicks never start a second command for an active default install', async () => {
    const { api } = await import('./api')
    mocks.commands.installMod.mockReturnValueOnce(new Promise(() => {}))
    void api.installMod(12, 'game', 'pd3')
    await expect(api.installMod(12, 'game', 'pd3')).rejects.toThrow()
    expect(mocks.commands.installMod).toHaveBeenCalledOnce()
})

test('resource review keeps the command pending and exposes review instead of stale percentage', async () => {
    const { api } = await import('./api')
    const state = await import('./installState')
    const review = await import('./resourceInstall')
    mocks.commands.installMod.mockResolvedValueOnce({
        needsResourceReview: { reviewHandle: 'review' },
    })
    const installing = api.installMod(12, 'game', 'ron')
    await Promise.resolve()
    expect(state.getResourceInstall('review')?.phase).toBe('review')
    review.finishResourceReview('review', false)
    await expect(installing).resolves.toBe('cancelled')
    expect(state.getInstallOperations('ron')).toEqual([])
})

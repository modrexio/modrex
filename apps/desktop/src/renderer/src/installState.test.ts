import { beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => {
    vi.resetModules()
})

test('game and provider identities isolate installs with the same remote id', async () => {
    const state = await import('./installState')
    state.beginInstall({ gameId: 'pd3', source: 'nexus', modId: 12, fileId: 34 })
    state.beginInstall({ gameId: 'pd2', source: 'nexus', modId: 12, fileId: 34 })
    state.beginInstall({ gameId: 'pd3', source: 'modworkshop', modId: 12, fileId: 34 })
    expect(state.getInstallOperations('pd3')).toHaveLength(2)
    expect(state.getInstallOperations('pd2')).toHaveLength(1)
    expect(state.getDownloadInstall('pd2', 'nxm:pd3:12:34')).toBeUndefined()
    expect(state.getDownloadInstall('pd3', 'file:12:34')?.target.source).toBe('modworkshop')
})

test('install state survives subscriber removal and returning to the same game', async () => {
    const state = await import('./installState')
    const listener = vi.fn()
    const off = state.subscribeInstallOperations('ron', listener)
    const operation = state.beginInstall({ gameId: 'ron', source: 'nexus', modId: 12 })
    const snapshot = state.getInstallOperations('ron')
    off()
    state.updateInstall(operation.id, { phase: 'installing' })
    expect(listener).toHaveBeenCalledOnce()
    expect(state.getInstallOperations('ron')).not.toBe(snapshot)
    expect(state.getInstallOperations('ron')[0].phase).toBe('installing')
    expect(state.getInstallOperations('ron')).toBe(state.getInstallOperations('ron'))
})

test('rejects overlapping default installs while allowing distinct selected files', async () => {
    const state = await import('./installState')
    const target = { gameId: 'pd3', source: 'modworkshop' as const, modId: 12, fileId: 34 }
    state.beginInstall(target)
    expect(() => state.beginInstall(target)).toThrow()
    expect(() => state.beginInstall({ ...target, fileId: undefined })).toThrow()
    state.beginInstall({ ...target, fileId: 35 })
    expect(state.getInstallOperations('pd3')).toHaveLength(2)
})

test('adopts a Nexus browser wait without losing the accepted operation', async () => {
    const state = await import('./installState')
    const waiting = state.beginInstall(
        { gameId: 'ron', source: 'nexus', modId: 12 },
        'awaitingNexus'
    )
    const accepted = state.acceptNexusInstall({
        gameId: 'ron',
        source: 'nexus',
        modId: 12,
        fileId: 34,
    })
    expect(accepted.id).toBe(waiting.id)
    expect(accepted.phase).toBe('preparing')
    expect(state.getInstallOperations('ron')).toHaveLength(1)
    expect(
        state.getModInstall(state.getInstallOperations('ron'), 'nexus', 12, 34)?.target.fileId
    ).toBe(34)
})

test('download bytes stop being presented when extracting or reviewing an archive', async () => {
    const state = await import('./installState')
    const operation = state.beginInstall({ gameId: 'pd3', source: 'modworkshop', modId: 12 })
    state.updateInstall(operation.id, { phase: 'downloading', downloaded: 100, total: 100 })
    expect(state.installProgress(state.getInstallOperations('pd3')[0])).toEqual({
        downloaded: 100,
        total: 100,
    })
    state.updateInstall(operation.id, { phase: 'installing' })
    expect(state.installProgress(state.getInstallOperations('pd3')[0])).toBeNull()
    state.updateInstall(operation.id, { phase: 'review', archiveHandle: 'archive' })
    expect(state.isInstallBusy(state.getArchiveInstall('archive'))).toBe(true)
    state.finishArchiveInstall('archive')
    expect(state.getInstallOperations('pd3')).toEqual([])
})

test('finishing package selection preserves an unfinished resource review', async () => {
    const state = await import('./installState')
    const operation = state.beginInstall({ gameId: 'ron', source: 'nexus', modId: 12, fileId: 34 })
    state.updateInstall(operation.id, {
        phase: 'review',
        archiveHandle: 'archive',
        reviewHandle: 'review',
    })
    state.finishArchiveInstall('archive')
    expect(state.getArchiveInstall('archive')).toBeUndefined()
    expect(state.getResourceInstall('review')?.phase).toBe('review')
    state.finishResourceInstall('review')
    expect(state.getInstallOperations('ron')).toEqual([])
})

test('an active selected-file operation takes precedence over a failed operation', async () => {
    const state = await import('./installState')
    const failed = state.beginInstall({
        gameId: 'pd3',
        source: 'modworkshop',
        modId: 12,
        fileId: 34,
    })
    const active = state.beginInstall({
        gameId: 'pd3',
        source: 'modworkshop',
        modId: 12,
        fileId: 35,
    })
    state.updateInstall(failed.id, { phase: 'failed', error: 'Download rejected' })
    expect(state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12)?.id).toBe(
        active.id
    )
    expect(
        state.isInstallBusy(
            state.getModInstall(state.getInstallOperations('pd3'), 'modworkshop', 12, 34)
        )
    ).toBe(false)
    state.clearInstallError(failed.id)
    expect(state.getInstallOperations('pd3')).toHaveLength(1)
})

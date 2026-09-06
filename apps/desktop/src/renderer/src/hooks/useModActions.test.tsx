// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { InstalledMod } from '../../../shared/types'

const disableMod = vi.fn<(uid: string, gamePath: string, gameId: string) => Promise<void>>()
const enableMod = vi.fn<(uid: string, gamePath: string, gameId: string) => Promise<void>>()

function mod(uid: string, name: string): InstalledMod {
    return {
        uid,
        id: 1,
        name,
        version: '1.0',
        filename: `${uid}.pak`,
        enabled: true,
        installedAt: '',
    } as InstalledMod
}

async function loadHook() {
    vi.resetModules()
    vi.doMock('../api', () => ({
        api: {
            disableMod,
            enableMod,
            uninstallMod: vi.fn().mockResolvedValue(undefined),
            onDownloadProgress: vi.fn(() => () => {}),
            installMod: vi.fn(),
        },
    }))
    return (await import('./useModActions')).useModActions
}

describe('useModActions bulk behaviour', () => {
    beforeEach(() => {
        disableMod.mockReset().mockResolvedValue(undefined)
        enableMod.mockReset().mockResolvedValue(undefined)
    })

    // A locked file in the middle of a selection must not decide the fate of the mods after
    // it, and the ones that already succeeded are on disk whatever happens next.
    it('attempts every mod, refreshes once and reports the one that failed', async () => {
        disableMod.mockImplementation(async (uid) => {
            if (uid === 'b') throw new Error('the file is in use')
        })
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleDisable([mod('a', 'Alpha'), mod('b', 'Beta'), mod('c', 'Gamma')])

        await waitFor(() => expect(result.current.modActionError).not.toBeNull())
        expect(disableMod).toHaveBeenCalledTimes(3)
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(result.current.modActionError).toContain('Beta')
        expect(result.current.modActionError).not.toContain('Alpha')
        expect(result.current.loadingMod).toBeNull()
    })

    // The list has to end up showing what is on disk, which is exactly what a caller cannot
    // know after a failure.
    it('refreshes even when every mod fails', async () => {
        disableMod.mockRejectedValue(new Error('the file is in use'))
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleDisable([mod('a', 'Alpha'), mod('b', 'Beta')])

        await waitFor(() => expect(result.current.modActionError).not.toBeNull())
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(result.current.loadingMod).toBeNull()
    })

    it('reports nothing and still refreshes when every mod succeeds', async () => {
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleEnable([mod('a', 'Alpha'), mod('b', 'Beta')])

        await waitFor(() => expect(result.current.loadingMod).toBeNull())
        expect(enableMod).toHaveBeenCalledTimes(2)
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(result.current.modActionError).toBeNull()
    })

    // The refresh runs in the action's own cleanup, so a rejection there used to skip the
    // loading reset and escape as an unhandled rejection, leaving the row spinning for good.
    it('clears the loading state and reports when the refresh fails', async () => {
        const onRefresh = vi.fn().mockRejectedValue(new Error('the list could not be read'))
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleDisable([mod('a', 'Alpha')])

        await waitFor(() => expect(result.current.modActionError).not.toBeNull())
        expect(result.current.loadingMod).toBeNull()
        expect(result.current.modActionError).toContain('the list could not be read')
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(disableMod).toHaveBeenCalledTimes(1)
    })

    it('keeps the mod failure when the refresh fails as well', async () => {
        disableMod.mockRejectedValue(new Error('the file is in use'))
        const onRefresh = vi.fn().mockRejectedValue(new Error('the list could not be read'))
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleDisable([mod('a', 'Alpha')])

        await waitFor(() => expect(result.current.modActionError).not.toBeNull())
        expect(result.current.loadingMod).toBeNull()
        expect(result.current.modActionError).toContain('Alpha')
        expect(result.current.modActionError).toContain('the file is in use')
    })

    // A stale message from the previous attempt would read as a fresh failure.
    it('clears a previous failure when the next attempt succeeds', async () => {
        disableMod.mockRejectedValueOnce(new Error('the file is in use'))
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useModActions = await loadHook()
        const { result } = renderHook(() => useModActions('C:/game', onRefresh, 'pd3'))

        await result.current.handleDisable([mod('a', 'Alpha')])
        await waitFor(() => expect(result.current.modActionError).not.toBeNull())

        await result.current.handleDisable([mod('a', 'Alpha')])
        await waitFor(() => expect(result.current.modActionError).toBeNull())
    })
})

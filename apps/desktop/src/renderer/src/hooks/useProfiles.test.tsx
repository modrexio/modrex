// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const listProfiles = vi.fn()
const switchProfile = vi.fn()
const createProfile = vi.fn()

async function loadHook() {
    vi.resetModules()
    vi.doMock('../api', () => ({ api: { listProfiles, switchProfile, createProfile } }))
    return (await import('./useProfiles')).useProfiles
}

const list = {
    profiles: [{ id: 'p1', name: 'Heists' }],
    active: null,
    unfinishedSwitch: null,
}

describe('useProfiles', () => {
    beforeEach(() => {
        listProfiles.mockReset().mockResolvedValue(list)
        switchProfile.mockReset().mockResolvedValue(undefined)
        createProfile.mockReset().mockResolvedValue({ id: 'p2', name: 'New' })
    })

    // A switch that stops part way has still moved files, so the installed list is read
    // again whatever happened.
    it('reports a failed switch and still reloads the installed list', async () => {
        switchProfile.mockRejectedValue('Close the game before switching profiles.')
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useProfiles = await loadHook()
        const { result } = renderHook(() => useProfiles('pd3', 'C:/game', onRefresh))
        await waitFor(() => expect(result.current.list).not.toBeNull())

        await act(() => result.current.switchTo('p1'))

        expect(result.current.error).toBe(
            'Could not switch to Heists: Close the game before switching profiles.'
        )
        expect(result.current.switching).toBeNull()
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(listProfiles).toHaveBeenCalledTimes(2)
    })

    it('resolves false and reports when a profile cannot be created', async () => {
        createProfile.mockRejectedValue('a profile needs a name')
        const useProfiles = await loadHook()
        const { result } = renderHook(() =>
            useProfiles('pd3', 'C:/game', vi.fn().mockResolvedValue(undefined))
        )
        await waitFor(() => expect(result.current.list).not.toBeNull())

        let created = true
        await act(async () => {
            created = await result.current.create('', { kind: 'empty' })
        })

        expect(created).toBe(false)
        expect(result.current.error).toBe(
            'The profile could not be changed: a profile needs a name'
        )
    })

    it('keeps the page busy until both lists are read after a switch', async () => {
        let finishRefresh!: () => void
        const onRefresh = vi.fn(() => new Promise<void>((resolve) => (finishRefresh = resolve)))
        const useProfiles = await loadHook()
        const { result } = renderHook(() => useProfiles('pd3', 'C:/game', onRefresh))
        await waitFor(() => expect(result.current.list).not.toBeNull())

        let switched!: Promise<void>
        act(() => {
            switched = result.current.switchTo('p1')
        })
        await waitFor(() => expect(onRefresh).toHaveBeenCalled())
        expect(result.current.switching).toBe('p1')

        await act(async () => {
            finishRefresh()
            await switched
        })
        expect(result.current.switching).toBeNull()
    })

    it('reports an installed list that cannot be read after a switch', async () => {
        const onRefresh = vi.fn().mockRejectedValue('state file is locked')
        const useProfiles = await loadHook()
        const { result } = renderHook(() => useProfiles('pd3', 'C:/game', onRefresh))
        await waitFor(() => expect(result.current.list).not.toBeNull())

        await act(() => result.current.switchTo('p1'))

        expect(result.current.error).toBe(
            'The installed mod list could not be refreshed: state file is locked'
        )
        expect(result.current.switching).toBeNull()
    })

    // Switching store copies changes the path while the old copy's list may still be on its way.
    it('never shows a list that arrives for a copy the page has left', async () => {
        let answerOld!: (value: unknown) => void
        listProfiles
            .mockReset()
            .mockImplementation((_game: string, path: string) =>
                path === 'C:/steam'
                    ? new Promise((resolve) => (answerOld = resolve))
                    : Promise.resolve({ ...list, active: 'p1' })
            )
        const useProfiles = await loadHook()
        const { result, rerender } = renderHook(
            ({ path }) => useProfiles('pd3', path, vi.fn().mockResolvedValue(undefined)),
            { initialProps: { path: 'C:/steam' } }
        )
        rerender({ path: 'C:/xbox' })
        await waitFor(() => expect(result.current.list?.active).toBe('p1'))

        await act(async () => answerOld({ ...list, active: null }))

        expect(result.current.list?.active).toBe('p1')
    })

    it('loads nothing without a game folder', async () => {
        const useProfiles = await loadHook()
        const { result } = renderHook(() =>
            useProfiles('pd3', null, vi.fn().mockResolvedValue(undefined))
        )
        await Promise.resolve()
        expect(result.current.list).toBeNull()
        expect(listProfiles).not.toHaveBeenCalled()
    })
})

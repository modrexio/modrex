// @vitest-environment happy-dom
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { GameId } from '../../shared/types'
import type { InstallOutcome } from './api'

const mocks = vi.hoisted(() => ({ discard: vi.fn(), refresh: vi.fn(), log: vi.fn() }))
vi.mock('./api', () => ({ api: { discardStagedArchive: mocks.discard } }))
vi.mock('@tauri-apps/plugin-log', () => ({ error: mocks.log }))
vi.mock('./gameData', () => {
    const data = { path: undefined, installed: undefined }
    return {
        getGameData: () => data,
        subscribeGameData: () => () => {},
        refreshInstalled: mocks.refresh,
    }
})
vi.mock('./components/ZipPickerModal', () => ({
    ZipPickerModal: ({
        payload,
        gameId,
        gamePath,
        folderId,
        onRefreshInstalled,
        onClose,
        visible,
    }: {
        payload: { modName: string }
        gameId: GameId
        gamePath: string
        folderId: string | null
        onRefreshInstalled: () => Promise<void>
        onClose: () => void
        visible: boolean
    }) => {
        const [selection, setSelection] = useState('')
        return (
            <div hidden={!visible}>
                <span>{payload.modName}</span>
                <span>
                    {gameId}:{gamePath}:{folderId}
                </span>
                <button onClick={onRefreshInstalled}>Refresh</button>
                <button onClick={onClose}>Cancel</button>
                <input
                    aria-label="Variant"
                    value={selection}
                    onChange={(event) => setSelection(event.target.value)}
                />
            </div>
        )
    },
}))

import {
    finishInstallChoice,
    getPendingInstallChoice,
    requestInstallChoice,
    useInstallChoiceOpen,
} from './installChoices'
import { finishResourceReview, requestResourceReview } from './resourceInstall'
import { InstallChoiceDialog } from './components/InstallChoiceDialog'
import {
    beginInstall,
    updateInstall,
    getArchiveInstall,
    finishArchiveInstall,
} from './installState'

function archive(name: string): InstallOutcome {
    return {
        needsPicker: {
            archiveHandle: name,
            modName: name,
            modId: 1,
            fileId: 1,
            fileType: 'zip',
            modVersion: '1',
            entries: ['one.pak'],
            entryIds: [0],
            targetTag: null,
            sharedPaks: false,
        },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.discard.mockImplementation(async (handle: string) => finishArchiveInstall(handle))
    mocks.refresh.mockResolvedValue(undefined)
    for (const [gameId, modId, handle] of [
        ['pd3', 1, 'first'],
        ['cb', 1, 'second'],
        ['pd3', 2, 'ordinary'],
    ] as const) {
        const operation = beginInstall({ gameId, source: 'modworkshop', modId })
        updateInstall(operation.id, { phase: 'review', archiveHandle: handle })
    }
})

afterEach(() => {
    cleanup()
    while (getPendingInstallChoice()) finishInstallChoice(getPendingInstallChoice()!)
    for (const handle of ['first', 'second', 'ordinary']) finishArchiveInstall(handle)
})

it('keeps a pending archive choice across host remounts with its original target', async () => {
    const finished = vi.fn()
    const review = requestInstallChoice(archive('first'), 'pd3', '/original', [], 'folder').then(
        finished
    )
    const host = render(<InstallChoiceDialog />)
    expect(screen.getByText('pd3:/original:folder')).toBeTruthy()
    fireEvent.click(screen.getByText('Refresh'))
    expect(mocks.refresh).toHaveBeenCalledWith('pd3')
    host.unmount()
    expect(finished).not.toHaveBeenCalled()
    render(<InstallChoiceDialog />)
    fireEvent.click(screen.getByText('Cancel'))
    await review
    expect(mocks.discard).toHaveBeenCalledWith('first')
    expect(finished).toHaveBeenCalledWith(undefined)
    expect(getPendingInstallChoice()).toBeNull()
})

it('awaits archive cleanup before displaying the next queued choice', async () => {
    let finishCleanup!: () => void
    mocks.discard.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finishCleanup = resolve
            })
    )
    const first = requestInstallChoice(archive('first'), 'pd3', '/first')
    const second = requestInstallChoice(archive('second'), 'cb', '/second')
    render(<InstallChoiceDialog />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('second')).toBeNull()
    await act(async () => finishCleanup())
    await first
    expect(screen.getByText('second')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    await second
    expect(mocks.discard.mock.calls).toEqual([['first'], ['second']])
})

it('retains a failed cleanup and its review operation until retry succeeds', async () => {
    mocks.discard.mockRejectedValueOnce(new Error('archive locked'))
    const finished = vi.fn()
    const first = requestInstallChoice(archive('first'), 'pd3', '/first').then(finished)
    const second = requestInstallChoice(archive('second'), 'cb', '/second')
    const host = render(<InstallChoiceDialog />)
    fireEvent.click(screen.getByText('Cancel'))
    expect((await screen.findByRole('alert')).textContent).toContain('archive locked')
    expect(finished).not.toHaveBeenCalled()
    expect(getArchiveInstall('first')?.phase).toBe('review')
    expect(getPendingInstallChoice()?.outcome).toEqual(archive('first'))
    expect(mocks.log).toHaveBeenCalledWith('Archive choice cleanup failed: Error: archive locked')
    host.unmount()
    render(<InstallChoiceDialog />)
    fireEvent.click(screen.getByText('Try again'))
    await first
    expect(getArchiveInstall('first')).toBeUndefined()
    await screen.findByText('second')
    fireEvent.click(screen.getByText('Cancel'))
    await second
})

it('preserves the archive selection while a resource review takes focus', async () => {
    const ordinary = requestInstallChoice(archive('ordinary'), 'pd3', '/original')
    const { result } = renderHook(useInstallChoiceOpen)
    render(<InstallChoiceDialog />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Variant' }), {
        target: { value: 'keep this variant' },
    })
    let resource!: Promise<boolean>
    act(() => {
        resource = requestResourceReview('resource')
    })
    expect(result.current).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Variant' })).toBeNull()
    act(() => finishResourceReview('resource', false))
    await resource
    expect((screen.getByRole('textbox', { name: 'Variant' }) as HTMLInputElement).value).toBe(
        'keep this variant'
    )
    fireEvent.click(screen.getByText('Cancel'))
    await ordinary
    await waitFor(() => expect(result.current).toBe(false))
})

it('does not turn installed or cancelled outcomes into a choice', async () => {
    await requestInstallChoice('installed', 'pd3', '/game')
    await requestInstallChoice('cancelled', 'pd3', '/game')
    expect(getPendingInstallChoice()).toBeNull()
    expect(() => requestInstallChoice('unrecognized', 'pd3', '/game')).toThrow('mod ID')
})

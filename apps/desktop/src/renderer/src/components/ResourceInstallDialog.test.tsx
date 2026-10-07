// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceInstallDialog } from './ResourceInstallDialog'
import { api } from '../api'
import {
    finishResourceReview,
    getPendingResourceReview,
    requestResourceReview,
} from '../resourceInstall'

vi.mock('../api', () => ({
    api: {
        getResourceReview: vi.fn(),
        installReviewedResources: vi.fn(),
        cancelResourceReview: vi.fn(() => Promise.resolve()),
    },
}))

vi.mock('./Select', () => ({
    Select: ({
        onChange,
        options,
    }: {
        onChange: (value: string) => void
        options: { value: string; label: string }[]
    }) => <button onClick={() => onChange(options[1].value)}>{options[1].label}</button>,
}))

afterEach(() => {
    cleanup()
    const handle = getPendingResourceReview()
    if (handle) finishResourceReview(handle, false)
    vi.clearAllMocks()
})

describe('resource review completion', () => {
    it('reports matching movies without canceling an already completed review', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue({
            reviewHandle: 'matching',
            gameId: 'pd3',
            gamePath: '/games/pd3',
            modName: 'Intro',
            source: null,
            configPath: null,
            pakPicker: null,
            moviePackApplied: false,
            movieConflicts: [],
            iniConflicts: [],
            movieSlots: ['Intro.bk2'],
            entries: [
                {
                    entryId: 0,
                    name: 'replacement.bk2',
                    kind: 'movie',
                    supported: true,
                    reason: null,
                    changes: [],
                    keys: [],
                },
            ],
        })
        vi.mocked(api.installReviewedResources).mockResolvedValue({
            installed: false,
            alreadyCurrentMovies: ['/games/pd3/Movies/Intro.bk2'],
        })
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('checkbox', { name: 'replacement.bk2' }))
        fireEvent.click(screen.getByRole('button', { name: 'Intro.bk2' }))
        fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }))
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain('did not take ownership')
        )
        expect(api.installReviewedResources).toHaveBeenCalledWith('matching', [
            { entryId: 0, slot: 'Intro.bk2' },
        ])
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
        await expect(completed).resolves.toBe(false)
        expect(api.cancelResourceReview).not.toHaveBeenCalled()
        expect(getPendingResourceReview()).toBeNull()
    })
})

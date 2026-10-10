// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceInstallDialog } from './ResourceInstallDialog'
import { api, type ResourceReview } from '../api'
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
        pickEngineIni: vi.fn(),
        openEngineIni: vi.fn(),
    },
}))

vi.mock('./Select', () => ({
    Select: ({
        value,
        onChange,
        options,
        ariaLabel,
    }: {
        value: string
        onChange: (value: string) => void
        options: { value: string; label: string }[]
        ariaLabel: string
    }) => (
        <select
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}))

const reviewFixture: ResourceReview = {
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
}

afterEach(() => {
    cleanup()
    const handle = getPendingResourceReview()
    if (handle) finishResourceReview(handle, false)
    vi.clearAllMocks()
})

describe('resource review completion', () => {
    it('reports matching movies without canceling an already completed review', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue(reviewFixture)
        vi.mocked(api.installReviewedResources).mockResolvedValue({
            installed: false,
            alreadyCurrentMovies: ['/games/pd3/Movies/Intro.bk2'],
        })
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('checkbox', { name: 'replacement.bk2' }))
        expect(
            screen.getByRole('button', { name: 'Install selected' }).hasAttribute('disabled')
        ).toBe(true)
        expect(screen.getByRole('status').textContent).toContain('Choose a game movie')
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Intro.bk2' } })
        fireEvent.click(screen.getByRole('button', { name: 'Install selected' }))
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain(
                'did not save an earlier setup'
            )
        )
        expect(api.installReviewedResources).toHaveBeenCalledWith('matching', [
            { entryId: 0, slot: 'Intro.bk2' },
        ])
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
        await expect(completed).resolves.toBe(false)
        expect(api.cancelResourceReview).not.toHaveBeenCalled()
        expect(getPendingResourceReview()).toBeNull()
    })

    it('suggests an exact movie destination and installs only the chosen INI variant', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            configPath: '/config/Engine.ini',
            entries: [
                { ...reviewFixture.entries[0], name: 'Intro.bk2' },
                {
                    entryId: 1,
                    name: 'small/Engine.ini',
                    kind: 'ini',
                    supported: true,
                    reason: null,
                    changes: [],
                    keys: [],
                },
                {
                    entryId: 2,
                    name: 'large/Engine.ini',
                    kind: 'ini',
                    supported: true,
                    reason: null,
                    changes: [],
                    keys: [],
                },
            ],
        })
        vi.mocked(api.installReviewedResources).mockResolvedValue({
            installed: true,
            alreadyCurrentMovies: [],
        })
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Intro.bk2' }))
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('Intro.bk2')
        fireEvent.click(screen.getByRole('radio', { name: 'small/Engine.ini' }))
        fireEvent.click(screen.getByRole('radio', { name: 'large/Engine.ini' }))
        expect(
            (screen.getByRole('radio', { name: 'small/Engine.ini' }) as HTMLInputElement).checked
        ).toBe(false)
        expect(
            (screen.getByRole('radio', { name: 'large/Engine.ini' }) as HTMLInputElement).checked
        ).toBe(true)
        expect(screen.queryByRole('button', { name: 'Review in editor' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Install selected' }))
        await expect(completed).resolves.toBe(true)
        expect(api.installReviewedResources).toHaveBeenCalledWith('matching', [
            { entryId: 0, slot: 'Intro.bk2' },
            { entryId: 2, slot: null },
        ])
    })

    it('selects an INI destination without launching an editor', async () => {
        const review: ResourceReview = {
            ...reviewFixture,
            entries: [
                {
                    entryId: 1,
                    name: 'Engine.ini',
                    kind: 'ini',
                    supported: true,
                    reason: null,
                    changes: [],
                    keys: [],
                },
            ],
        }
        vi.mocked(api.getResourceReview)
            .mockResolvedValueOnce(review)
            .mockResolvedValueOnce({ ...review, configPath: '/config/Engine.ini' })
        vi.mocked(api.pickEngineIni).mockResolvedValue('/config/Engine.ini')
        void requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('radio', { name: 'Engine.ini' }))
        fireEvent.click(screen.getByRole('button', { name: 'Choose Engine.ini' }))
        await screen.findByText('/config/Engine.ini')
        expect(api.pickEngineIni).toHaveBeenCalledExactlyOnceWith('pd3', 'Choose Engine.ini', false)
        expect(api.openEngineIni).not.toHaveBeenCalled()
        expect(api.getResourceReview).toHaveBeenCalledTimes(2)
        expect(
            screen.getByRole('button', { name: 'Install selected' }).hasAttribute('disabled')
        ).toBe(false)
    })

    it('explains missing configuration and allows skipping INI presets', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            entries: [
                {
                    entryId: 1,
                    name: 'Engine.ini',
                    kind: 'ini',
                    supported: true,
                    reason: null,
                    changes: [],
                    keys: [],
                },
            ],
        })
        void requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('radio', { name: 'Engine.ini' }))
        expect(
            screen.getByRole('button', { name: 'Install selected' }).hasAttribute('disabled')
        ).toBe(true)
        expect(screen.getByRole('status').textContent).toContain(
            "Choose your game's active Engine.ini"
        )
        expect(screen.getByRole('button', { name: 'Choose Engine.ini' })).toBeTruthy()
        expect(screen.queryByText(/cannot apply this preset automatically/)).toBeNull()
        fireEvent.click(screen.getByRole('radio', { name: 'Skip INI presets' }))
        expect(screen.getByRole('status').textContent).toContain(
            'Select a movie replacement or INI preset'
        )
        expect(api.installReviewedResources).not.toHaveBeenCalled()
    })

    it('explains a target configuration problem without requiring manual installation', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            configPath: '/config/Engine.ini',
            entries: [
                {
                    entryId: 1,
                    name: 'Engine.ini',
                    kind: 'ini',
                    supported: false,
                    reason: 'Engine.ini mixes line-ending styles.',
                    changes: [],
                    keys: [],
                },
            ],
        })
        void requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        expect(await screen.findByText(/cannot apply this preset automatically/)).toBeTruthy()
        expect(screen.queryByText(/requires manual installation/)).toBeNull()
        fireEvent.click(
            screen.getByText('This file cannot be installed automatically. View the reason.')
        )
        expect(screen.getByText('Engine.ini mixes line-ending styles.')).toBeTruthy()
        expect(
            screen.getByRole('button', { name: 'Install selected' }).hasAttribute('disabled')
        ).toBe(true)
        expect(api.installReviewedResources).not.toHaveBeenCalled()
    })
})

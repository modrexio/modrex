// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceInstallDialog } from './ResourceInstallDialog'
import { api, type ResourceReview } from '../api'
import { getCachedMod } from '../modCache'
import type { Mod } from '../../../shared/types'
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
        getInstalled: vi.fn(),
        installNexusReviewPak: vi.fn(),
        discardStagedArchive: vi.fn(() => Promise.resolve()),
    },
}))

vi.mock('../gameData', () => ({ refreshInstalled: vi.fn(() => Promise.resolve()) }))
vi.mock('../modCache', () => ({ getCachedMod: vi.fn() }))
vi.mock('./MarkdownContent', () => ({
    ModworkshopMarkup: ({ text }: { text: string }) => <div>{text}</div>,
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
    movieDetails: {},
    remoteId: null,
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

const pakReview: ResourceReview = {
    ...reviewFixture,
    gameId: 'ron',
    gamePath: 'G:/Ready Or Not',
    modName: 'Six Days',
    source: 'nexus',
    entries: [],
    movieSlots: [],
    pakPicker: {
        archiveHandle: 'nexus-paks',
        sharedPaks: true,
        entries: ['Hard/Hard_P.pak', 'Realistic/Realistic_P.pak'],
        entryIds: [5, 8],
        targetTag: null,
        modId: 2759,
        fileId: 30700,
        modName: 'Six Days',
        fileType: 'zip',
        modVersion: '13',
    },
}

afterEach(() => {
    cleanup()
    const handle = getPendingResourceReview()
    if (handle) finishResourceReview(handle, false)
    vi.clearAllMocks()
})

describe('resource review completion', () => {
    it('installs only the explicitly chosen Nexus package and completes its review', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue(pakReview)
        vi.mocked(api.getInstalled).mockResolvedValue({
            mods: [],
            folders: [],
            modsHidden: false,
            stateUnreadable: false,
            resourceRecoveryPending: false,
        })
        vi.mocked(api.installNexusReviewPak).mockResolvedValue(undefined)
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('button', { name: 'Review package mods' }))
        expect(await screen.findByRole('button', { name: 'Install Selected (0)' })).toHaveProperty(
            'disabled',
            true
        )
        expect(api.installNexusReviewPak).not.toHaveBeenCalled()
        fireEvent.click(screen.getByText('Realistic_P.pak'))
        fireEvent.click(screen.getByRole('button', { name: 'Install Selected (1)' }))
        await screen.findByRole('button', { name: 'Package mods installed' })
        expect(api.installNexusReviewPak).toHaveBeenCalledExactlyOnceWith('matching', 8, null)
        expect(api.discardStagedArchive).toHaveBeenCalledExactlyOnceWith('nexus-paks')
        expect(api.installReviewedResources).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Finish review' }))
        await expect(completed).resolves.toBe(true)
        expect(api.cancelResourceReview).toHaveBeenCalledExactlyOnceWith('matching')
    })

    it('cancels a pending package review without reporting an install', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue(pakReview)
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
        await expect(completed).resolves.toBe(false)
        expect(api.cancelResourceReview).toHaveBeenCalledExactlyOnceWith('matching')
        expect(api.installNexusReviewPak).not.toHaveBeenCalled()
        expect(api.discardStagedArchive).not.toHaveBeenCalled()
    })

    it('keeps the Nexus grant pending after an install failure and reports an applied earlier entry', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue(pakReview)
        vi.mocked(api.getInstalled).mockResolvedValue({
            mods: [],
            folders: [],
            modsHidden: false,
            stateUnreadable: false,
            resourceRecoveryPending: false,
        })
        vi.mocked(api.installNexusReviewPak)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('Previous variant needs review'))
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        fireEvent.click(await screen.findByRole('button', { name: 'Review package mods' }))
        fireEvent.click(await screen.findByText('Hard_P.pak'))
        fireEvent.click(screen.getByText('Realistic_P.pak'))
        fireEvent.click(screen.getByRole('button', { name: 'Install Selected (2)' }))
        await screen.findByText('Error: Previous variant needs review')
        expect(api.discardStagedArchive).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(await screen.findByRole('button', { name: 'Review package mods' })).toHaveProperty(
            'disabled',
            false
        )
        fireEvent.click(await screen.findByRole('button', { name: 'Finish review' }))
        await expect(completed).resolves.toBe(true)
        expect(api.cancelResourceReview).toHaveBeenCalledExactlyOnceWith('matching')
    })
    it('reports matching movies without canceling an already completed review', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue(reviewFixture)
        vi.mocked(api.installReviewedResources).mockResolvedValue({
            installed: false,
            alreadyCurrentMovies: ['/games/pd3/Movies/Intro.bk2'],
        })
        const completed = requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        expect(
            ((await screen.findByRole('checkbox', { name: 'replacement.bk2' })) as HTMLInputElement)
                .checked
        ).toBe(true)
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
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
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!)
        await expect(completed).resolves.toBe(false)
        expect(api.cancelResourceReview).not.toHaveBeenCalled()
        expect(getPendingResourceReview()).toBeNull()
    })

    it('describes each game movie and shows the author instructions', async () => {
        vi.mocked(getCachedMod).mockResolvedValue({
            instructions: 'Rename it to Intro.bk2',
            legacy_markup: false,
        } as Mod)
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            source: 'modworkshop',
            remoteId: '57781',
            movieDetails: {
                'Intro.bk2': { seconds: 14.2, width: 1920, height: 1080, sound: true },
            },
        })
        requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        expect(
            await screen.findByRole('option', {
                name: 'Intro.bk2 (0:14, 1920x1080, with sound)',
            })
        ).toBeTruthy()
        expect(await screen.findByText('Rename it to Intro.bk2')).toBeTruthy()
        expect(getCachedMod).toHaveBeenCalledWith(57781)
    })

    it('reports unavailable instructions and names a slot without readable details', async () => {
        vi.mocked(getCachedMod).mockRejectedValue(new Error('API 429'))
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            source: 'modworkshop',
            remoteId: '57781',
            movieDetails: {
                'Intro.bk2': { seconds: null, width: 1920, height: 1080, sound: true },
            },
        })
        requestResourceReview('matching')
        render(<ResourceInstallDialog />)
        expect(await screen.findByRole('option', { name: 'Intro.bk2' })).toBeTruthy()
        expect(
            await screen.findByText("The author's instructions could not be loaded: Error: API 429")
        ).toBeTruthy()
    })

    it('suggests an exact movie destination and installs only the chosen INI variant', async () => {
        vi.mocked(api.getResourceReview).mockResolvedValue({
            ...reviewFixture,
            configPath: '/config/Engine.ini',
            entries: [
                { ...reviewFixture.entries[0]!, name: 'Intro.bk2' },
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
        expect(
            ((await screen.findByRole('checkbox', { name: 'Intro.bk2' })) as HTMLInputElement)
                .checked
        ).toBe(true)
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

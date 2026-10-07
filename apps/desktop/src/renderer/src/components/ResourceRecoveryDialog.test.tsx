// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceRecoveryDialog } from './ResourceRecoveryDialog'
import { api, type ResourceRecoveryReview } from '../api'
import { refreshInstalled } from '../gameData'

vi.mock('../api', () => ({
    api: {
        reviewResourceRecovery: vi.fn(),
        cancelResourceRecovery: vi.fn(() => Promise.resolve()),
        keepCurrentResources: vi.fn(() => Promise.resolve()),
    },
}))
vi.mock('../gameData', () => ({ refreshInstalled: vi.fn(() => Promise.resolve()) }))
vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }))

const review: ResourceRecoveryReview = {
    reviewHandle: 'recovery',
    gameId: 'pd3',
    deployments: ['Intro'],
    files: [
        {
            path: String.raw`\\?\G:\game\Movies\Intro.bk2`,
            current: { state: 'present', sha256: 'a'.repeat(64), size: 2048 },
        },
    ],
}

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

test('opens the affected mod directly and confirms keeping the current files', async () => {
    vi.mocked(api.reviewResourceRecovery).mockResolvedValue(review)
    const onClose = vi.fn()
    render(
        <ResourceRecoveryDialog
            activeGame="pd3"
            resource={{ uid: 'resource:intro', name: 'Intro' }}
            onClose={onClose}
        />
    )
    expect(await screen.findByText('Files that will be kept')).toBeTruthy()
    expect(screen.queryByText(/Modrex has paused changes/)).toBeNull()
    expect(screen.getByText(/Review your current files before stopping Modrex/)).toBeTruthy()
    expect(api.reviewResourceRecovery).toHaveBeenCalledWith('pd3', 'resource:intro')
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText(String.raw`G:\game\Movies\Intro.bk2`)).toBeTruthy()
    expect(screen.queryByText(review.files[0].path)).toBeNull()
    expect(api.keepCurrentResources).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current files' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(api.keepCurrentResources).toHaveBeenCalledExactlyOnceWith('recovery')
    expect(refreshInstalled).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(api.cancelResourceRecovery).not.toHaveBeenCalled()
})

test('cancelling releases the review without keeping or changing files', async () => {
    vi.mocked(api.reviewResourceRecovery).mockResolvedValue(review)
    const onClose = vi.fn()
    render(
        <ResourceRecoveryDialog
            activeGame="pd3"
            resource={{ uid: 'resource:intro', name: 'Intro' }}
            onClose={onClose}
        />
    )
    await screen.findByText('Files that will be kept')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(api.cancelResourceRecovery).toHaveBeenCalledExactlyOnceWith('recovery')
    expect(api.keepCurrentResources).not.toHaveBeenCalled()
})

test('releases a late review after its game workspace closes', async () => {
    let resolve!: (value: ResourceRecoveryReview) => void
    vi.mocked(api.reviewResourceRecovery).mockImplementationOnce(
        () =>
            new Promise((done) => {
                resolve = done
            })
    )
    const mounted = render(<ResourceRecoveryDialog activeGame="pd3" onClose={vi.fn()} />)
    mounted.unmount()
    resolve(review)
    await waitFor(() =>
        expect(api.cancelResourceRecovery).toHaveBeenCalledExactlyOnceWith('recovery')
    )
    expect(api.keepCurrentResources).not.toHaveBeenCalled()
})

test('retries a failed list refresh without repeating the completed recovery', async () => {
    vi.mocked(api.reviewResourceRecovery).mockResolvedValue(review)
    vi.mocked(refreshInstalled).mockRejectedValueOnce(new Error('List unavailable'))
    const onClose = vi.fn()
    render(
        <ResourceRecoveryDialog
            activeGame="pd3"
            resource={{ uid: 'resource:intro', name: 'Intro' }}
            onClose={onClose}
        />
    )
    await screen.findByText('Files that will be kept')
    fireEvent.click(screen.getByRole('button', { name: 'Keep current files' }))
    await screen.findByRole('alert')
    expect(
        screen.getByText(
            'Your current files have been kept. Modrex has stopped managing the affected mods.'
        )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(api.reviewResourceRecovery).toHaveBeenCalledOnce()
    expect(api.keepCurrentResources).toHaveBeenCalledExactlyOnceWith('recovery')
    expect(refreshInstalled).toHaveBeenCalledTimes(2)
})

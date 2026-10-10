// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../api'
import { RecoveryFolderButton } from './RecoveryFolderButton'

vi.mock('../api', () => ({ api: { openResourceRecoveryFolder: vi.fn() } }))

afterEach(() => {
    cleanup()
    vi.resetAllMocks()
})

test('reports absent recovery files as an empty state and permits checking again', async () => {
    vi.mocked(api.openResourceRecoveryFolder)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
    render(<RecoveryFolderButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery folder' }))
    expect((await screen.findByRole('status')).textContent).toBe('No recovery files are available.')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery folder' }))
    await waitFor(() => expect(api.openResourceRecoveryFolder).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
})

test('shows a failed native handoff and clears it after a successful retry', async () => {
    vi.mocked(api.openResourceRecoveryFolder)
        .mockRejectedValueOnce(new Error('Could not open the recovery folder: permission denied'))
        .mockResolvedValueOnce(true)
    render(<RecoveryFolderButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery folder' }))
    expect((await screen.findByRole('alert')).textContent).toContain('permission denied')
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery folder' }))
    await waitFor(() => expect(api.openResourceRecoveryFolder).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
})

test('disables the button while the folder handoff is pending', async () => {
    let resolveOpen!: (opened: boolean) => void
    vi.mocked(api.openResourceRecoveryFolder).mockReturnValueOnce(
        new Promise((resolve) => {
            resolveOpen = resolve
        })
    )
    render(<RecoveryFolderButton />)
    const button = screen.getByRole('button', { name: 'Open recovery folder' })
    fireEvent.click(button)
    expect(button.hasAttribute('disabled')).toBe(true)
    resolveOpen(true)
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
})

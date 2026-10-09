// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PendingGameLaunch } from '../api'
import { GameTopBar } from './GameTopBar'

const launch = vi.hoisted(() => ({
    state: {
        running: false,
        launching: null,
        pending: null as PendingGameLaunch | null,
        error: null,
        warning: null,
    },
    reset: vi.fn(),
}))
vi.mock('../gameLaunch', () => ({
    getLaunchState: () => launch.state,
    subscribeLaunchState: () => () => {},
    launchGame: vi.fn(),
    stopGame: vi.fn(),
    dismissLaunchError: vi.fn(),
    dismissLaunchWarning: vi.fn(),
    resetPendingLaunch: launch.reset,
}))
vi.mock('./TopBar', () => ({
    TopBar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
beforeEach(() => {
    vi.resetAllMocks()
    launch.state = { running: false, launching: null, pending: null, error: null, warning: null }
    launch.reset.mockResolvedValue(undefined)
})
afterEach(cleanup)

test.each(['preparing', 'handedOff'] as const)(
    'offers reset only after %s reaches handoff',
    (pending) => {
        launch.state = { ...launch.state, pending }
        render(<GameTopBar activeGame="pd3" gamePath="G:/Games" />)
        expect(screen.getByRole('button', { name: 'Launch modded' }).hasAttribute('disabled')).toBe(
            true
        )
        const reset = screen.queryByRole('button', { name: 'Reset launch status' })
        expect(Boolean(reset)).toBe(pending === 'handedOff')
    }
)

test('explains external cancellation and hidden package restoration before a confirmed reset', async () => {
    launch.state = { ...launch.state, pending: 'handedOff' }
    render(<GameTopBar activeGame="pd3" gamePath="G:/Games" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset launch status' }))
    const dialog = screen.getByRole('dialog')
    expect(
        within(dialog).getByText(/Cancel the pending launch in your game launcher first/)
    ).toBeTruthy()
    expect(
        within(dialog).getByText(/Resetting restores any package mods hidden for this launch/)
    ).toBeTruthy()
    expect(within(dialog).getByText(/It does not cancel the external launch/)).toBeTruthy()
    expect(launch.reset).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset launch status' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(launch.reset).toHaveBeenCalledExactlyOnceWith('pd3')
})

test('keeps the dialog open with the native error when reset fails', async () => {
    launch.state = { ...launch.state, pending: 'handedOff' }
    launch.reset.mockRejectedValue(new Error('Close the game before resetting its pending launch'))
    render(<GameTopBar activeGame="pd3" gamePath="G:/Games" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset launch status' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset launch status' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Close the game')
    expect(
        within(dialog).getByRole('button', { name: 'Reset launch status' }).hasAttribute('disabled')
    ).toBe(false)
})

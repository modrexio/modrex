// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PendingGameLaunch, ProfileList } from '../api'
import type { Profiles } from '../hooks/useProfiles'
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

function profilesOf(list: ProfileList | null, overrides: Partial<Profiles> = {}): Profiles {
    return {
        list,
        switching: null,
        error: null,
        clearError: vi.fn(),
        switchTo: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(true),
        rename: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(undefined),
        dismissPending: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined),
        pendingShown: false,
        showPending: vi.fn(),
        ...overrides,
    }
}

test.each(['preparing', 'handedOff'] as const)(
    'offers reset only after %s reaches handoff',
    (pending) => {
        launch.state = { ...launch.state, pending }
        render(
            <GameTopBar
                activeGame="pd3"
                gamePath="G:/Games"
                profiles={profilesOf(null)}
                onOpenMod={vi.fn()}
            />
        )
        expect(screen.getByRole('button', { name: 'Launch modded' }).hasAttribute('disabled')).toBe(
            true
        )
        const reset = screen.queryByRole('button', { name: 'Reset launch status' })
        expect(Boolean(reset)).toBe(pending === 'handedOff')
    }
)

test('explains external cancellation and hidden package restoration before a confirmed reset', async () => {
    launch.state = { ...launch.state, pending: 'handedOff' }
    render(
        <GameTopBar
            activeGame="pd3"
            gamePath="G:/Games"
            profiles={profilesOf(null)}
            onOpenMod={vi.fn()}
        />
    )
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
    render(
        <GameTopBar
            activeGame="pd3"
            gamePath="G:/Games"
            profiles={profilesOf(null)}
            onOpenMod={vi.fn()}
        />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset launch status' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset launch status' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Close the game')
    expect(
        within(dialog).getByRole('button', { name: 'Reset launch status' }).hasAttribute('disabled')
    ).toBe(false)
})

const two: ProfileList = {
    profiles: [
        { id: 'p1', name: 'Heists' },
        { id: 'p2', name: 'Stealth' },
    ],
    active: 'p1',
    unfinishedSwitch: null,
    loaders: [],
    pending: [],
}

// A profile decides which mods a launch loads, so it is chosen right before the launch buttons.
test('puts the profile menu ahead of the launch buttons', () => {
    render(
        <GameTopBar
            activeGame="pd3"
            gamePath="G:/Games"
            profiles={profilesOf(two)}
            onOpenMod={vi.fn()}
        />
    )

    const buttons = screen
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(buttons.indexOf('Profiles: Heists')).toBe(0)
    expect(buttons.indexOf('Profiles: Heists')).toBeLessThan(buttons.indexOf('Launch modded'))
})

// The menu works from every page, so what a switch left behind has to show on every page too.
test('offers to finish a switch that stopped and shows why a switch failed', () => {
    const profiles = profilesOf(
        { ...two, unfinishedSwitch: 'p2' },
        { error: 'Could not switch to Stealth: Close the game before switching profiles.' }
    )
    render(
        <GameTopBar activeGame="pd3" gamePath="G:/Games" profiles={profiles} onOpenMod={vi.fn()} />
    )

    expect(screen.getByText(/Close the game before switching profiles/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Finish switch' }))
    expect(profiles.switchTo).toHaveBeenCalledWith('p2')
})

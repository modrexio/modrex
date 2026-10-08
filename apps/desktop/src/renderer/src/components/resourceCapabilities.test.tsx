// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { GAMES, type GameId, type InstalledMod } from '../../../shared/types'

const { cachedSettings } = vi.hoisted(() => ({ cachedSettings: vi.fn() }))
vi.mock('../settingsCache', () => ({ getSettingsCache: cachedSettings }))

vi.mock('../../../shared/types', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../shared/types')>()
    return { ...actual, GAMES: { ...actual.GAMES } }
})
vi.mock('../api', () => ({ api: {} }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
vi.mock('./MovieResourceScan', () => ({
    MovieResourceScan: ({ activeGame }: { activeGame: string }) => (
        <div data-testid="movie-scan" data-game={activeGame} />
    ),
}))
vi.mock('./TopBar', () => ({ TopBar: ({ children }: { children: ReactNode }) => children }))
vi.mock('./Tooltip', () => ({
    Tooltip: ({ children, content }: { children: ReactNode; content: string }) => (
        <div data-description={content}>{children}</div>
    ),
}))
vi.mock('../gameLaunch', () => {
    const state = { running: false, launching: null, error: null, warning: null }
    return {
        getLaunchState: () => state,
        subscribeLaunchState: () => () => {},
        launchGame: vi.fn(),
        stopGame: vi.fn(),
        dismissLaunchError: vi.fn(),
        dismissLaunchWarning: vi.fn(),
    }
})

import { HealthCheckModal } from './HealthCheckModal'
import { GameTopBar } from './GameTopBar'

const original = GAMES.pd2
afterEach(() => {
    GAMES.pd2 = original
    cachedSettings.mockReset()
    cleanup()
})

function health(
    installed: InstalledMod[] = [],
    onReviewResource = vi.fn(),
    gameId: GameId = 'pd2'
) {
    render(
        <HealthCheckModal
            updateVersions={new Map()}
            installed={installed}
            updatable={[]}
            modData={new Map()}
            missingDeps={[]}
            showDepsTab={false}
            leftovers={{ sets: [], error: null }}
            onLeftoversChanged={vi.fn()}
            gamePath="C:/game"
            gameId={gameId}
            loadingMod={null}
            visible
            onOpenDetail={vi.fn()}
            onReinstall={vi.fn()}
            onDepInstalled={vi.fn()}
            onReviewUpdates={vi.fn()}
            onReviewResource={onReviewResource}
            onClose={vi.fn()}
        />
    )
}

it('keeps config-only recovery available without a movie scan', () => {
    GAMES.pd2 = { ...original, configPresets: { filename: 'Engine.ini' } }
    const mod: InstalledMod = {
        uid: 'resource:config',
        id: -1,
        name: 'UI preset',
        filename: 'Engine.ini',
        version: '',
        enabled: true,
        installedAt: '',
        deployment: 'ini',
        resourceStatus: 'diverged',
    }
    const review = vi.fn()
    health([mod], review)
    expect(screen.getByRole('tab', { name: 'Game files' })).toBeTruthy()
    expect(screen.queryByTestId('movie-scan')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review files' }))
    expect(review).toHaveBeenCalledExactlyOnceWith(mod)
})

it('offers a movie scan from the declaration of a game with no hardcoded resource ID', () => {
    GAMES.pd2 = {
        ...original,
        movieReplacement: { extension: 'bk2', storefronts: ['steam'] },
    }
    health()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Game files' }))
    expect(screen.getByTestId('movie-scan').getAttribute('data-game')).toBe('pd2')
})

it('keeps existing deployments recoverable after install support is removed', () => {
    health([
        {
            uid: 'resource:movie',
            id: -1,
            name: 'Old intro',
            filename: 'Intro.bk2',
            version: '',
            enabled: true,
            installedAt: '',
            deployment: 'movie',
            resourceStatus: 'blocked',
        },
    ])
    expect(screen.getByRole('button', { name: 'Review files' })).toBeTruthy()
    expect(screen.queryByTestId('movie-scan')).toBeNull()
})

it('keeps PAYDAY 3 recovery visible on Xbox without offering its unsupported movie scan', () => {
    cachedSettings.mockReturnValue({ settings: { gamePath: 'C:/game', launcher: 'xbox' } })
    health(
        [
            {
                uid: 'resource:movie',
                id: -1,
                name: 'Old intro',
                filename: 'Intro.bk2',
                version: '',
                enabled: true,
                installedAt: '',
                deployment: 'movie',
                resourceStatus: 'blocked',
            },
        ],
        vi.fn(),
        'pd3'
    )
    expect(screen.getByRole('button', { name: 'Review files' })).toBeTruthy()
    expect(screen.queryByTestId('movie-scan')).toBeNull()
})

it.each(['steam', 'manual', 'unknown', null])(
    'allows inventory scanning for launcher %s',
    (launcher) => {
        GAMES.pd2 = { ...original, movieReplacement: { extension: 'bk2', storefronts: ['steam'] } }
        cachedSettings.mockReturnValue({ settings: { gamePath: 'C:/game', launcher } })
        health()
        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Game files' }))
        expect(screen.getByTestId('movie-scan')).toBeTruthy()
    }
)

it('ignores a cached launcher that belongs to a different game installation', () => {
    GAMES.pd2 = { ...original, movieReplacement: { extension: 'bk2', storefronts: ['steam'] } }
    cachedSettings.mockReturnValue({ settings: { gamePath: 'C:/another-copy', launcher: 'xbox' } })
    health()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Game files' }))
    expect(screen.getByTestId('movie-scan')).toBeTruthy()
})

it('omits resource tools for a game with no declarations or deployments', () => {
    health()
    expect(screen.queryByRole('tab', { name: 'Game files' })).toBeNull()
})

it.each(['movies', 'config'] as const)(
    'labels a %s-only package-disabled launch accurately',
    (kind) => {
        GAMES.pd2 =
            kind === 'movies'
                ? { ...original, movieReplacement: { extension: 'bk2', storefronts: ['steam'] } }
                : { ...original, configPresets: { filename: 'Engine.ini' } }
        render(<GameTopBar activeGame="pd2" gamePath="C:/game" />)
        const button = screen.getByRole('button', { name: 'Launch without package mods' })
        expect(button.parentElement?.getAttribute('data-description')).toBe(
            kind === 'movies'
                ? 'Temporarily disables mod folders. Movie replacements stay selected.'
                : 'Temporarily disables mod folders. INI settings stay selected.'
        )
    }
)

it('retains the ordinary launch label for a game with no resources', () => {
    render(<GameTopBar activeGame="pd2" gamePath="C:/game" />)
    expect(screen.getByRole('button', { name: 'Launch without mods' })).toBeTruthy()
})

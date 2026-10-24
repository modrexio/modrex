// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { GameId } from '../../../shared/types'

vi.mock('../api')
vi.mock('./SourceSelect', () => ({ SourceSelect: () => null }))
vi.mock('./ScrollArea', () => ({
    ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./ModCard', () => ({ ModCard: () => null }))

import { api } from '../api'
import { loadSourceRegistry } from '../sources'
import { t } from '../i18n'
import { NexusBrowsePage } from './NexusBrowsePage'
import { resetNexusSignInForTests } from '../hooks/useNexusSignIn'

beforeEach(async () => {
    localStorage.clear()
    vi.mocked(api.isNexusSignedIn).mockResolvedValue(false)
    vi.mocked(api.nexusOAuthStart).mockResolvedValue(undefined)
    vi.mocked(api.onNexusOAuthCallbackReceived).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthFailed).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthSignedIn).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusSessionExpired).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusSignedOut).mockImplementation(() => vi.fn())
    vi.mocked(api.listSources).mockResolvedValue([
        {
            id: 'nexus',
            games: [
                { gameId: 'ron', nativeId: 'readyornot' },
                { gameId: 'pd3', nativeId: 'payday3' },
            ],
        },
    ])
    await loadSourceRegistry()
})

afterEach(() => {
    cleanup()
    resetNexusSignInForTests()
    vi.useRealTimers()
    vi.resetAllMocks()
})

async function renderPage(activeGame: GameId = 'ron') {
    render(
        <NexusBrowsePage
            activeGame={activeGame}
            isActive
            source="nexus"
            onSourceChange={vi.fn()}
            gamePath={null}
            installed={[]}
            onRefreshInstalled={vi.fn()}
            onOpenDetail={vi.fn()}
        />
    )
    const button = await screen.findByRole('button', { name: t('settings.nexusAccount.signIn') })
    // The prompt mounts after the async signed-in check, and the shared sign-in store
    // subscribes in an effect that can commit after the button is already in the DOM.
    await waitFor(() => expect(api.onNexusOAuthFailed).toHaveBeenCalled())
    return button
}

describe('Nexus browse sign-in', () => {
    it('hides the loaded pagination footer on sign-out and clears expiry guidance', async () => {
        await renderPage()
        vi.mocked(api.nexusSearchMods).mockResolvedValue({
            data: [],
            meta: { total: 5151, current_page: 1, last_page: 215, per_page: 24 },
        })
        act(() => {
            for (const [onSignedIn] of vi.mocked(api.onNexusOAuthSignedIn).mock.calls) onSignedIn()
        })
        await screen.findByText(t('nexus.modCount', { total: 5151 }))
        expect(screen.getByRole('button', { name: '215' })).toBeTruthy()
        act(() => vi.mocked(api.onNexusSignedOut).mock.calls[0]![0]())
        expect(screen.queryByText(t('nexus.modCount', { total: 5151 }))).toBeNull()
        expect(screen.queryByRole('button', { name: '215' })).toBeNull()
        expect(screen.getByRole('button', { name: t('settings.nexusAccount.signIn') })).toBeTruthy()
        act(() => vi.mocked(api.onNexusSessionExpired).mock.calls[0]![0]())
        expect(screen.getByText(t('nexus.sessionExpiredHint'))).toBeTruthy()
        act(() => vi.mocked(api.onNexusSignedOut).mock.calls[0]![0]())
        expect(screen.queryByText(t('nexus.sessionExpiredHint'))).toBeNull()
    })

    it.each(['ron', 'pd3'] as const)(
        'offers direct sign-in for %s and disables filters',
        async (game) => {
            await renderPage(game)
            expect(screen.queryByText(t('nexus.goToSettings'))).toBeNull()
            expect(screen.queryByText(t('nexus.signInRequired'))).toBeNull()
            expect(screen.getByRole<HTMLInputElement>('textbox').disabled).toBe(true)
            expect(screen.getByRole<HTMLButtonElement>('combobox').disabled).toBe(true)
        }
    )

    it('starts sign-in from the prompt and shows its progress', async () => {
        const button = await renderPage()
        fireEvent.click(button)
        expect(api.nexusOAuthStart).toHaveBeenCalledOnce()
        expect(screen.getByText(t('settings.nexusAccount.awaitingBrowser'))).toBeTruthy()
    })

    it('loads mods in place once sign-in succeeds', async () => {
        const button = await renderPage()
        fireEvent.click(button)
        vi.mocked(api.nexusSearchMods).mockResolvedValue({
            data: [],
            meta: { total: 0, current_page: 1, last_page: 1, per_page: 24 },
        })
        act(() => {
            for (const [onSignedIn] of vi.mocked(api.onNexusOAuthSignedIn).mock.calls) onSignedIn()
        })
        await waitFor(() =>
            expect(screen.getByRole<HTMLInputElement>('textbox').disabled).toBe(false)
        )
        expect(screen.queryByRole('button', { name: t('settings.nexusAccount.signIn') })).toBeNull()
    })

    it('offers sign-in again when the session expires', async () => {
        await renderPage()
        act(() => vi.mocked(api.onNexusSessionExpired).mock.calls[0]![0]())
        expect(screen.getByText(t('nexus.sessionExpiredHint'))).toBeTruthy()
        expect(screen.getByRole('button', { name: t('nexusSession.signIn') })).toBeTruthy()
    })
})

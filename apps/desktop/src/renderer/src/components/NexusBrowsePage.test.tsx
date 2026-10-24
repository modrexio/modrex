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

    it('starts sign-in and allows another attempt while waiting', async () => {
        const button = await renderPage()
        fireEvent.click(button)
        expect(api.nexusOAuthStart).toHaveBeenCalledTimes(1)
        expect(
            screen
                .getByText('Continue in your browser. If it asks to open Modrex, choose Open.')
                .getAttribute('aria-live')
        ).toBe('polite')
        expect((button as HTMLButtonElement).disabled).toBe(false)
        fireEvent.click(button)
        expect(api.nexusOAuthStart).toHaveBeenCalledTimes(2)
    })

    it('shows recovery guidance and keeps the sign-in action after interruption', async () => {
        const button = await renderPage()
        vi.useFakeTimers()
        fireEvent.click(button)
        act(() => window.dispatchEvent(new Event('focus')))
        act(() => vi.advanceTimersByTime(2000))
        const status = screen.getByText(t('settings.nexusAccount.interrupted'))
        expect(status.className).toContain('text-warning')
        expect(status.getAttribute('aria-live')).toBe('polite')
        expect(screen.getByRole('button', { name: t('settings.nexusAccount.signIn') })).toBe(button)
        fireEvent.click(button)
        expect(screen.queryByText(t('settings.nexusAccount.interrupted'))).toBeNull()
        expect(screen.getByText(t('settings.nexusAccount.awaitingBrowser'))).toBeTruthy()
    })

    it('shows finishing status after the callback and lets errors take priority', async () => {
        const button = await renderPage()
        fireEvent.click(button)
        act(() => vi.mocked(api.onNexusOAuthCallbackReceived).mock.calls[0]![0]())
        const status = screen.getByText('Finishing sign-in...')
        expect(status.className).toContain('text-text-subtle')
        expect(status.getAttribute('aria-live')).toBe('polite')
        expect(screen.queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()
        act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
        act(() => vi.mocked(api.onNexusOAuthCallbackReceived).mock.calls[0]![0]())
        expect(screen.queryByText('Finishing sign-in...')).toBeNull()
        expect(
            screen.getByText(t('settings.nexusAccount.failed', { error: 'Access denied' }))
        ).toBeTruthy()
    })

    it('shows a failed start and clears the error on retry', async () => {
        vi.mocked(api.nexusOAuthStart).mockRejectedValueOnce('Browser unavailable')
        const button = await renderPage()
        fireEvent.click(button)
        await screen.findByText(t('settings.nexusAccount.failed', { error: 'Browser unavailable' }))
        expect(screen.queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()
        fireEvent.click(button)
        expect(
            screen.queryByText(t('settings.nexusAccount.failed', { error: 'Browser unavailable' }))
        ).toBeNull()
        expect(screen.getByText(t('settings.nexusAccount.awaitingBrowser'))).toBeTruthy()
    })

    it('handles callback failures and clears waiting on success without navigating', async () => {
        const button = await renderPage()
        fireEvent.click(button)
        act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
        expect(
            screen.getByText(t('settings.nexusAccount.failed', { error: 'Access denied' }))
        ).toBeTruthy()
        expect(screen.queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()
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
        expect(screen.queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()
        expect(screen.queryByRole('button', { name: t('settings.nexusAccount.signIn') })).toBeNull()
    })

    it('offers sign-in again when the session expires', async () => {
        await renderPage()
        act(() => vi.mocked(api.onNexusSessionExpired).mock.calls[0]![0]())
        expect(screen.getByText(t('nexus.sessionExpiredHint'))).toBeTruthy()
        expect(screen.getByRole('button', { name: t('nexusSession.signIn') })).toBeTruthy()
    })

    it('keeps the shared sign-in subscriptions when the prompt unmounts', async () => {
        await renderPage()
        const offFailed = vi.mocked(api.onNexusOAuthFailed).mock.results[0]!.value
        cleanup()
        expect(offFailed).not.toHaveBeenCalled()
    })
})

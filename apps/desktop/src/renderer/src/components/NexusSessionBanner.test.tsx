// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../api')

import { api } from '../api'
import { resetNexusSignInForTests } from '../hooks/useNexusSignIn'
import { t } from '../i18n'
import { NexusSessionBanner } from './NexusSessionBanner'
import { NexusSignInPrompt } from './NexusSignInPrompt'

beforeEach(() => {
    vi.mocked(api.nexusOAuthStart).mockResolvedValue(undefined)
    vi.mocked(api.onNexusOAuthCallbackReceived).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthFailed).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthSignedIn).mockImplementation(() => vi.fn())
})

afterEach(() => {
    cleanup()
    resetNexusSignInForTests()
    vi.useRealTimers()
    vi.resetAllMocks()
})

it('shares progress with the prompt and puts status in the banner message slot', () => {
    const dismiss = vi.fn()
    const { container } = render(
        <>
            <NexusSessionBanner onDismiss={dismiss} />
            <NexusSignInPrompt sessionExpired />
        </>
    )
    const banner = container.firstElementChild as HTMLElement
    const message = banner.firstElementChild as HTMLElement
    const actions = banner.lastElementChild as HTMLElement
    expect(within(message).getByText(t('nexusSession.expired'))).toBeTruthy()
    fireEvent.click(within(actions).getByRole('button', { name: t('nexusSession.signIn') }))
    expect(screen.getAllByText(t('settings.nexusAccount.awaitingBrowser'))).toHaveLength(2)
    expect(within(message).getByText(t('settings.nexusAccount.awaitingBrowser'))).toBeTruthy()
    expect(actions.children).toHaveLength(2)
    expect(within(actions).queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()

    act(() => vi.mocked(api.onNexusOAuthCallbackReceived).mock.calls[0]![0]())
    expect(within(message).getByText(t('settings.nexusAccount.finishing'))).toBeTruthy()
    act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
    act(() => vi.mocked(api.onNexusOAuthCallbackReceived).mock.calls[0]![0]())
    expect(
        within(message).getByText(t('nexusSession.failed', { error: 'Access denied' }))
    ).toBeTruthy()
    expect(within(message).queryByText(t('settings.nexusAccount.finishing'))).toBeNull()
    fireEvent.click(within(actions).getByRole('button', { name: t('common.dismiss') }))
    expect(dismiss).toHaveBeenCalledOnce()
})

it('keeps interrupted guidance in the warning message slot', () => {
    vi.useFakeTimers()
    const { container } = render(<NexusSessionBanner onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: t('nexusSession.signIn') }))
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => vi.advanceTimersByTime(2000))
    const message = screen.getByText(
        "Sign-in didn't finish. When your browser asks to open Modrex, choose Open."
    )
    expect(message.parentElement).toBe(container.firstElementChild?.firstElementChild)
    expect(message.className).toBe('truncate')
    expect(container.firstElementChild?.className).toContain('text-warning')
    expect(message.getAttribute('aria-live')).toBe('polite')
})

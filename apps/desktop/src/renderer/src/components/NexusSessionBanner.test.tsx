// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../api')

import { api } from '../api'
import { resetNexusSignInForTests } from '../hooks/useNexusSignIn'
import { t } from '../i18n'
import { NexusSessionBanner } from './NexusSessionBanner'

beforeEach(() => {
    vi.mocked(api.nexusOAuthStart).mockResolvedValue(undefined)
    vi.mocked(api.onNexusOAuthCallbackReceived).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthFailed).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthSignedIn).mockImplementation(() => vi.fn())
})

afterEach(() => {
    cleanup()
    resetNexusSignInForTests()
    vi.resetAllMocks()
})

it('replaces the expired message with sign-in progress, then with an error', () => {
    const dismiss = vi.fn()
    render(<NexusSessionBanner onDismiss={dismiss} />)
    expect(screen.getByText(t('nexusSession.expired'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('nexusSession.signIn') }))
    expect(screen.getByText(t('settings.nexusAccount.awaitingBrowser'))).toBeTruthy()
    expect(screen.queryByText(t('nexusSession.expired'))).toBeNull()

    act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
    expect(screen.getByText(t('nexusSession.failed', { error: 'Access denied' }))).toBeTruthy()
    expect(screen.queryByText(t('settings.nexusAccount.awaitingBrowser'))).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('common.dismiss') }))
    expect(dismiss).toHaveBeenCalledOnce()
})

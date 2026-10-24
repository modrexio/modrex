// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

vi.mock('../api')

import { api } from '../api'
import { useNexusSignIn } from './useNexusSignIn'
import { resetNexusSignInForTests } from './useNexusSignIn'

beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(api.nexusOAuthStart).mockResolvedValue(undefined)
    vi.mocked(api.onNexusOAuthCallbackReceived).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthSignedIn).mockImplementation(() => vi.fn())
    vi.mocked(api.onNexusOAuthFailed).mockImplementation(() => vi.fn())
})

afterEach(() => {
    cleanup()
    resetNexusSignInForTests()
    vi.useRealTimers()
    vi.resetAllMocks()
})

describe('Nexus sign-in recovery', () => {
    it('waits for focus and the full grace before marking sign-in interrupted', async () => {
        const { result } = renderHook(useNexusSignIn)
        expect(result.current.status).toBe('idle')
        await act(() => result.current.signIn())
        act(() => vi.advanceTimersByTime(5000))
        expect(result.current.status).toBe('awaiting')

        act(() => window.dispatchEvent(new Event('focus')))
        act(() => vi.advanceTimersByTime(1999))
        expect(result.current.status).toBe('awaiting')
        act(() => vi.advanceTimersByTime(1))
        expect(result.current.status).toBe('interrupted')
    })

    it('finishes when the callback arrives during the focus grace', async () => {
        const { result } = renderHook(useNexusSignIn)
        await act(() => result.current.signIn())
        act(() => window.dispatchEvent(new Event('focus')))
        act(() => vi.advanceTimersByTime(1000))
        act(() => vi.mocked(api.onNexusOAuthCallbackReceived).mock.calls[0]![0]())
        expect(result.current.status).toBe('finishing')
        expect(vi.getTimerCount()).toBe(0)
        act(() => vi.advanceTimersByTime(5000))
        expect(result.current.status).toBe('finishing')

        act(() => vi.mocked(api.onNexusOAuthSignedIn).mock.calls[0]![0]())
        expect(result.current.status).toBe('idle')
        expect(result.current.error).toBeNull()
    })

    it('starts a fresh attempt after interruption', async () => {
        const { result } = renderHook(useNexusSignIn)
        await act(() => result.current.signIn())
        act(() => window.dispatchEvent(new Event('focus')))
        act(() => vi.advanceTimersByTime(2000))
        expect(result.current.status).toBe('interrupted')

        await act(() => result.current.signIn())
        expect(result.current.status).toBe('awaiting')
        expect(result.current.error).toBeNull()
        expect(api.nexusOAuthStart).toHaveBeenCalledTimes(2)
    })

    it('clears the focus timer on failure and clears the error on retry', async () => {
        const { result } = renderHook(useNexusSignIn)
        await act(() => result.current.signIn())
        act(() => window.dispatchEvent(new Event('focus')))
        act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
        expect(result.current.status).toBe('idle')
        expect(result.current.error).toBe('Access denied')
        expect(vi.getTimerCount()).toBe(0)
        act(() => vi.advanceTimersByTime(2000))
        expect(result.current.status).toBe('idle')

        await act(() => result.current.signIn())
        expect(result.current.status).toBe('awaiting')
        expect(result.current.error).toBeNull()
    })

    it('reports a rejected start and clears the error on success', async () => {
        vi.mocked(api.nexusOAuthStart).mockRejectedValueOnce('Browser unavailable')
        const { result } = renderHook(useNexusSignIn)
        await act(() => result.current.signIn())
        expect(result.current.status).toBe('idle')
        expect(result.current.error).toBe('Browser unavailable')
        act(() => vi.mocked(api.onNexusOAuthSignedIn).mock.calls[0]![0]())
        expect(result.current.error).toBeNull()
    })

    it('shares status, errors and subscriptions across consumers and remounts', async () => {
        const first = renderHook(useNexusSignIn)
        const second = renderHook(useNexusSignIn)
        expect(api.onNexusOAuthCallbackReceived).toHaveBeenCalledOnce()
        expect(api.onNexusOAuthSignedIn).toHaveBeenCalledOnce()
        expect(api.onNexusOAuthFailed).toHaveBeenCalledOnce()
        await act(() => first.result.current.signIn())
        expect(second.result.current.status).toBe('awaiting')
        act(() => window.dispatchEvent(new Event('focus')))
        expect(vi.getTimerCount()).toBe(1)
        first.unmount()
        second.unmount()
        act(() => vi.advanceTimersByTime(2000))
        const third = renderHook(useNexusSignIn)
        expect(third.result.current.status).toBe('interrupted')
        act(() => vi.mocked(api.onNexusOAuthFailed).mock.calls[0]![0]('Access denied'))
        const fourth = renderHook(useNexusSignIn)
        expect(fourth.result.current.error).toBe('Access denied')
        expect(api.onNexusOAuthFailed).toHaveBeenCalledOnce()
    })
})

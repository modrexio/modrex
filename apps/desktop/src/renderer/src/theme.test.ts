import { describe, it, expect, beforeEach, vi } from 'vitest'

function freshStorage() {
    const store = new Map<string, string>()
    return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
    }
}

async function loadModule() {
    vi.resetModules()
    return import('./theme')
}

describe('theme store', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('document', { documentElement: { dataset: {} } })
    })

    it('defaults to auto mode with the no-game theme', async () => {
        const { getThemeMode, getTheme, initTheme } = await loadModule()
        expect(getThemeMode()).toBe('auto')
        initTheme()
        expect(getTheme()).toBe('purple')
    })

    it('resolves an auto theme from the stored active game', async () => {
        localStorage.setItem('modrex:active-game', 'pd3')
        const { getTheme, initTheme } = await loadModule()
        initTheme()
        expect(getTheme()).toBe('green')
    })

    it('follows the game while in auto mode', async () => {
        const { getTheme, syncThemeForGame } = await loadModule()
        syncThemeForGame('pd3')
        expect(getTheme()).toBe('green')
        syncThemeForGame('pd2')
        expect(getTheme()).toBe('blue')
        syncThemeForGame('pdth')
        expect(getTheme()).toBe('red')
        syncThemeForGame('cb')
        expect(getTheme()).toBe('orange')
        syncThemeForGame('raid')
        expect(getTheme()).toBe('darkRed')
    })

    it('does not follow the game while a manual override is set', async () => {
        const { getTheme, setThemeMode, syncThemeForGame } = await loadModule()
        setThemeMode('purple')
        expect(getTheme()).toBe('purple')
        syncThemeForGame('pd3')
        expect(getTheme()).toBe('purple')
    })

    it('setThemeMode persists the choice, notifies subscribers, and re-resolves', async () => {
        const { setThemeMode, getThemeMode, getTheme, syncThemeForGame, subscribeTheme } =
            await loadModule()
        syncThemeForGame('pd2')
        expect(getTheme()).toBe('blue')
        const listener = vi.fn()
        subscribeTheme(listener)

        setThemeMode('green')

        expect(listener).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem('modrex:theme-mode')).toBe('green')
        expect(getThemeMode()).toBe('green')
        expect(getTheme()).toBe('green')
    })

    it('switching back to auto resolves to the last known game', async () => {
        const { setThemeMode, getTheme, syncThemeForGame } = await loadModule()
        syncThemeForGame('pd3')
        setThemeMode('red')
        expect(getTheme()).toBe('red')
        setThemeMode('auto')
        expect(getTheme()).toBe('green')
    })

    it('does not notify when setting the already-active mode', async () => {
        const { setThemeMode, getThemeMode, subscribeTheme } = await loadModule()
        expect(getThemeMode()).toBe('auto')
        const listener = vi.fn()
        subscribeTheme(listener)
        setThemeMode('auto')
        expect(listener).not.toHaveBeenCalled()
    })

    it('falls back to auto for an unknown stored mode', async () => {
        localStorage.setItem('modrex:theme-mode', 'no-such-theme')
        const { getThemeMode } = await loadModule()
        expect(getThemeMode()).toBe('auto')
    })
})

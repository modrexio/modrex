import { describe, it, expect, beforeEach, vi } from 'vitest'

function freshStorage() {
    const store = new Map<string, string>()
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
    }
}

async function loadModule() {
    vi.resetModules()
    return import('./accentColor')
}

describe('accent color store', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('document', { documentElement: { dataset: {} } })
    })

    it('defaults to Modrex orange', async () => {
        const { getAccentColor, initAccentColor } = await loadModule()
        expect(getAccentColor()).toBe('orange')
        initAccentColor()
        expect(document.documentElement.dataset.accent).toBe('orange')
    })

    it('loads and applies a saved accent color', async () => {
        localStorage.setItem('modrex:accent-color', 'gray')
        const { getAccentColor, initAccentColor } = await loadModule()
        expect(getAccentColor()).toBe('gray')
        initAccentColor()
        expect(document.documentElement.dataset.accent).toBe('gray')
    })

    it('does not derive the accent color from the active game', async () => {
        localStorage.setItem('modrex:active-game', 'pd3')
        const { getAccentColor } = await loadModule()
        expect(getAccentColor()).toBe('orange')
    })

    it('persists changes and notifies subscribers', async () => {
        const { setAccentColor, getAccentColor, subscribeAccentColor } = await loadModule()
        const listener = vi.fn()
        subscribeAccentColor(listener)

        setAccentColor('green')

        expect(listener).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem('modrex:accent-color')).toBe('green')
        expect(getAccentColor()).toBe('green')
        expect(document.documentElement.dataset.accent).toBe('green')
    })

    it('does not notify when setting the active color', async () => {
        const { setAccentColor, subscribeAccentColor } = await loadModule()
        const listener = vi.fn()
        subscribeAccentColor(listener)
        setAccentColor('orange')
        expect(listener).not.toHaveBeenCalled()
    })

    it('falls back to orange for an unknown saved value', async () => {
        localStorage.setItem('modrex:accent-color', 'no-such-color')
        const { getAccentColor } = await loadModule()
        expect(getAccentColor()).toBe('orange')
    })
})

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
    return import('./cornerRadius')
}

describe('corner radius store', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('document', { documentElement: { style: { setProperty: vi.fn() } } })
    })

    it('defaults to 4px and applies it as --modrex-radius', async () => {
        const { getCornerRadius, initCornerRadius } = await loadModule()
        expect(getCornerRadius()).toBe(4)
        initCornerRadius()
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
            '--modrex-radius',
            '4px'
        )
    })

    it('loads and applies a saved radius', async () => {
        localStorage.setItem('modrex:corner-radius', '8')
        const { getCornerRadius, initCornerRadius } = await loadModule()
        expect(getCornerRadius()).toBe(8)
        initCornerRadius()
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
            '--modrex-radius',
            '8px'
        )
    })

    it('applies the minimum and maximum unchanged', async () => {
        localStorage.setItem('modrex:corner-radius', '0')
        const { getCornerRadius } = await loadModule()
        expect(getCornerRadius()).toBe(0)
    })

    it('persists changes and notifies subscribers', async () => {
        const { setCornerRadius, getCornerRadius, subscribeCornerRadius } = await loadModule()
        const listener = vi.fn()
        subscribeCornerRadius(listener)

        setCornerRadius(7)

        expect(listener).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem('modrex:corner-radius')).toBe('7')
        expect(getCornerRadius()).toBe(7)
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
            '--modrex-radius',
            '7px'
        )
    })

    it('does not notify when setting the active radius', async () => {
        const { setCornerRadius, subscribeCornerRadius } = await loadModule()
        const listener = vi.fn()
        subscribeCornerRadius(listener)
        setCornerRadius(4)
        expect(listener).not.toHaveBeenCalled()
    })

    it('falls back to 4px for a non-numeric saved value', async () => {
        localStorage.setItem('modrex:corner-radius', 'quite-round')
        const { getCornerRadius } = await loadModule()
        expect(getCornerRadius()).toBe(4)
    })

    it('falls back to 4px for an out-of-range saved value', async () => {
        localStorage.setItem('modrex:corner-radius', '40')
        const { getCornerRadius } = await loadModule()
        expect(getCornerRadius()).toBe(4)
    })
})

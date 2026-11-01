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

describe('corner scale store', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('document', { documentElement: { style: { setProperty: vi.fn() } } })
    })

    it('defaults to the design unchanged', async () => {
        const { getCornerScale, initCornerScale } = await loadModule()
        expect(getCornerScale()).toBe(1)
        initCornerScale()
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
            '--modrex-radius-scale',
            '1'
        )
    })

    it('loads a saved scale', async () => {
        localStorage.setItem('modrex:corner-scale', '2.75')
        const { getCornerScale } = await loadModule()
        expect(getCornerScale()).toBe(2.75)
    })

    it.each(['round', '-1', '9', ''])('ignores the saved value %j', async (saved) => {
        localStorage.setItem('modrex:corner-scale', saved)
        const { getCornerScale } = await loadModule()
        expect(getCornerScale()).toBe(1)
    })

    it('persists, applies and announces a change', async () => {
        const { setCornerScale, getCornerScale, subscribeCornerScale } = await loadModule()
        const listener = vi.fn()
        subscribeCornerScale(listener)

        setCornerScale(0.5)

        expect(listener).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem('modrex:corner-scale')).toBe('0.5')
        expect(getCornerScale()).toBe(0.5)
        expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
            '--modrex-radius-scale',
            '0.5'
        )
    })

    it('stays quiet when the scale does not change', async () => {
        const { setCornerScale, subscribeCornerScale } = await loadModule()
        const listener = vi.fn()
        subscribeCornerScale(listener)
        setCornerScale(1)
        expect(listener).not.toHaveBeenCalled()
    })
})

describe('corner bar position', () => {
    it('puts sharp, default and maximum at the start, middle and end', async () => {
        const { cornerScaleFromPosition, MAX_CORNER_SCALE } = await loadModule()
        expect(cornerScaleFromPosition(0)).toBe(0)
        expect(cornerScaleFromPosition(50)).toBe(1)
        expect(cornerScaleFromPosition(100)).toBe(MAX_CORNER_SCALE)
    })

    it('returns every bar position from the scale it produces', async () => {
        const { cornerScaleFromPosition, cornerPositionFromScale } = await loadModule()
        for (let position = 0; position <= 100; position++) {
            expect(cornerPositionFromScale(cornerScaleFromPosition(position))).toBe(position)
        }
    })

    it('grows with the bar', async () => {
        const { cornerScaleFromPosition } = await loadModule()
        for (let position = 1; position <= 100; position++) {
            expect(cornerScaleFromPosition(position)).toBeGreaterThan(
                cornerScaleFromPosition(position - 1)
            )
        }
    })
})

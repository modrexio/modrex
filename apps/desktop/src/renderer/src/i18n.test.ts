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
    return import('./i18n')
}

describe('t', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    })

    it('resolves a known key', async () => {
        const { t } = await loadModule()
        expect(t('common.install')).toBe('Install')
    })

    it('interpolates provided vars', async () => {
        const { t } = await loadModule()
        expect(t('common.by' as never, { name: 'Alice' })).toBe('by Alice')
    })

    it('leaves an unmatched token untouched when a var is missing', async () => {
        const { t } = await loadModule()
        expect(t('common.by' as never, {})).toBe('by {name}')
    })

    it('falls back to the raw key when it resolves nowhere', async () => {
        const { t } = await loadModule()
        expect(t('nonexistent.key' as never)).toBe('nonexistent.key')
    })

    it('falls back to current English for a marked locale value', async () => {
        vi.doMock('./locales', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./locales')>()
            return {
                ...actual,
                RAW_BUNDLES: {
                    ...actual.RAW_BUNDLES,
                    xx: { common: { install: '! Outdated English' } },
                },
                LOCALE_IDS: [...actual.LOCALE_IDS, 'xx'],
                isLocaleId: (value: string | null) => value === 'xx' || actual.isLocaleId(value),
            }
        })
        const { setLocale, t } = await loadModule()

        setLocale('xx')

        expect(t('common.install')).toBe('Install')
        vi.doUnmock('./locales')
    })
})

describe('locale store', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    })

    it('defaults to en with no saved preference', async () => {
        const { getLocale } = await loadModule()
        expect(getLocale()).toBe('en')
    })

    it('restores a saved locale on load', async () => {
        localStorage.setItem('modrex:locale', 'en')
        const { getLocale } = await loadModule()
        expect(getLocale()).toBe('en')
    })

    it('matches navigator.languages by primary subtag when nothing is saved', async () => {
        vi.stubGlobal('navigator', { language: 'en-GB', languages: ['xx-XX', 'en-GB'] })
        const { getLocale } = await loadModule()
        expect(getLocale()).toBe('en')
    })

    it('falls back to en when no navigator language matches a registered locale', async () => {
        vi.stubGlobal('navigator', { language: 'xx-XX', languages: ['xx-XX'] })
        const { getLocale } = await loadModule()
        expect(getLocale()).toBe('en')
    })

    it('setLocale persists the choice, notifies subscribers, and falls back to en for an unbundled locale', async () => {
        vi.doMock('./locales', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./locales')>()
            return {
                ...actual,
                isLocaleId: (v: string | null) => v === 'xx' || actual.isLocaleId(v),
            }
        })
        const { setLocale, subscribeLocale, t } = await loadModule()
        const listener = vi.fn()
        subscribeLocale(listener)

        setLocale('xx' as never)

        expect(listener).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem('modrex:locale')).toBe('xx')
        expect(t('common.install')).toBe('Install')
        vi.doUnmock('./locales')
    })

    it('does not notify when setting the already-active locale', async () => {
        const { setLocale, subscribeLocale, getLocale } = await loadModule()
        expect(getLocale()).toBe('en')
        const listener = vi.fn()
        subscribeLocale(listener)
        setLocale('en')
        expect(listener).not.toHaveBeenCalled()
    })
})

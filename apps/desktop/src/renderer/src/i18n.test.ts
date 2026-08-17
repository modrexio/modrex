import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseSourceValue, parseTargetValue, resolveTargetValue } from '../../shared/i18n-values.js'

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

async function loadTargetBundle(bundle: Record<string, unknown>) {
    vi.doMock('./locales', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./locales')>()
        return {
            ...actual,
            RAW_BUNDLES: { ...actual.RAW_BUNDLES, xx: bundle },
            LOCALE_IDS: [...actual.LOCALE_IDS, 'xx'],
            isLocaleId: (value: string | null) => value === 'xx' || actual.isLocaleId(value),
        }
    })
    const module = await loadModule()
    module.setLocale('xx')
    return module
}

describe('t', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', freshStorage())
        vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    })

    afterEach(() => vi.doUnmock('./locales'))

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
        const { t } = await loadTargetBundle({ common: { install: '! Outdated English' } })
        expect(t('common.install')).toBe('Install')
    })

    it('falls back to current English for an absent target value', async () => {
        const { t } = await loadTargetBundle({})
        expect(t('common.install')).toBe('Install')
    })

    it('renders a compatible pending target without its marker', async () => {
        const { t } = await loadTargetBundle({ common: { by: '? von {name}' } })
        expect(t('common.by' as never, { name: 'Alice' })).toBe('von Alice')
    })

    it('falls back before interpolation for an incompatible pending target', async () => {
        const bundle = { installed: { modCount: '? {name} Mods' } }
        const original = structuredClone(bundle)
        const { t } = await loadTargetBundle(bundle)

        expect(t('installed.modCount', { count: 2, name: 'Alice' })).toBe('2 mods')
        expect(bundle).toEqual(original)
    })

    it('renders a compatible accepted target unchanged', async () => {
        const { t } = await loadTargetBundle({ installed: { modCount: '{count} Mods' } })
        expect(t('installed.modCount', { count: 2 })).toBe('2 Mods')
    })

    it('defensively falls back for an incompatible accepted target', async () => {
        const { t } = await loadTargetBundle({ installed: { modCount: '{name} Mods' } })
        expect(t('installed.modCount', { count: 2, name: 'Alice' })).toBe('2 mods')
    })

    it('resolves singular and plural members independently', async () => {
        const acceptedPlural = await loadTargetBundle({
            installed: { modCount: '{count} Mods', modCountSingle: '! Old singular' },
        })
        expect(acceptedPlural.t('installed.modCount', { count: 2 })).toBe('2 Mods')
        expect(acceptedPlural.t('installed.modCountSingle', { count: 1 })).toBe('1 mod')

        const acceptedSingular = await loadTargetBundle({
            installed: { modCount: '! Old plural', modCountSingle: '{count} Mod' },
        })
        expect(acceptedSingular.t('installed.modCount', { count: 2 })).toBe('2 mods')
        expect(acceptedSingular.t('installed.modCountSingle', { count: 1 })).toBe('1 Mod')

        const mixedPending = await loadTargetBundle({
            installed: { modCount: '? {count} Mods', modCountSingle: '? {name} Mod' },
        })
        expect(mixedPending.t('installed.modCount', { count: 2 })).toBe('2 Mods')
        expect(mixedPending.t('installed.modCountSingle', { count: 1 })).toBe('1 mod')
    })
})

describe('runtime value resolution', () => {
    it('keeps workflow-looking English source text raw', () => {
        for (const sourceText of ['? English question', '! English statement']) {
            expect(
                resolveTargetValue(parseSourceValue(sourceText), parseTargetValue(undefined))
            ).toBe(sourceText)
        }
    })

    it('compares duplicate placeholders as a multiset', () => {
        const source = parseSourceValue('{name} {name}')
        expect(resolveTargetValue(source, parseTargetValue('? {name}'))).toBe('{name} {name}')
        expect(resolveTargetValue(source, parseTargetValue('? {name}, then {name}'))).toBe(
            '{name}, then {name}'
        )
    })

    it('allows placeholder order to differ in prose', () => {
        const source = parseSourceValue('{first} then {second}')
        expect(resolveTargetValue(source, parseTargetValue('? {second} before {first}'))).toBe(
            '{second} before {first}'
        )
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

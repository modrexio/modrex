import { describe, it, expect } from 'vitest'
import { LOCALE_IDS, isLocaleId, localeNativeName, localeLabel, matchLocale } from './locales'

describe('LOCALE_IDS', () => {
    it('discovers every locale file with en first', () => {
        expect(LOCALE_IDS[0]).toBe('en')
        expect(LOCALE_IDS).toContain('en')
    })
})

describe('isLocaleId', () => {
    it('accepts a discovered locale', () => {
        expect(isLocaleId('en')).toBe(true)
    })

    it('rejects an unregistered locale and null', () => {
        expect(isLocaleId('xx')).toBe(false)
        expect(isLocaleId(null)).toBe(false)
    })
})

describe('matchLocale', () => {
    it('prefers an exact regional locale', () => {
        expect(matchLocale('pt-BR', ['en', 'pt', 'pt-BR'])).toBe('pt-BR')
    })

    it('falls back from a regional locale to its base language', () => {
        expect(matchLocale('pt-PT', ['en', 'pt'])).toBe('pt')
    })

    it('falls back through script and extension subtags', () => {
        expect(matchLocale('sr-Latn-RS', ['en', 'sr-Latn'])).toBe('sr-Latn')
        expect(matchLocale('de-DE-u-co-phonebk', ['en', 'de-DE'])).toBe('de-DE')
    })

    it('does not substitute a different regional variant', () => {
        expect(matchLocale('pt-PT', ['en', 'pt-BR'])).toBeNull()
    })

    it('canonicalizes browser language tags and rejects malformed tags', () => {
        expect(matchLocale('EN-us', ['en'])).toBe('en')
        expect(matchLocale('not_a_locale', ['en'])).toBeNull()
    })
})

describe('localeNativeName', () => {
    it("resolves a locale's name in its own language", () => {
        expect(localeNativeName('en')).toBe('English')
    })

    it("capitalizes languages that don't capitalize their own name in prose", () => {
        expect(localeNativeName('ru')).toBe('Русский')
    })

    it('falls back to the raw id when the tag is malformed', () => {
        expect(localeNativeName('!!!not-a-tag!!!')).toBe('!!!not-a-tag!!!')
    })
})

describe('localeLabel', () => {
    it('prefixes the native name with the uppercased code', () => {
        expect(localeLabel('en')).toBe('EN  English')
    })
})

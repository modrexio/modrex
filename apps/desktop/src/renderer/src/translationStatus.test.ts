import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRANSLATION_COVERAGE, translationCoverage } from './translationStatus'
import { LOCALE_IDS } from './locales'

describe('translationCoverage', () => {
    afterEach(() => {
        vi.doUnmock('./i18n/en.json')
        vi.doUnmock('./locales')
    })

    it('counts only source keys with usable target text', () => {
        const source = {
            common: {
                install: 'Install',
                cancel: 'Cancel',
                by: 'by {name}',
                count: '{count} mods',
                same: 'Modrex',
            },
            missingSection: { title: 'Settings' },
        }
        const target = {
            common: {
                install: 'Installieren',
                cancel: '! Cancel',
                by: '? von {name}',
                count: '{name} Mods',
                same: 'Modrex',
                extra: 'Extra',
            },
        }

        expect(translationCoverage(source, target)).toEqual({ translated: 3, total: 6 })
    })

    it('excludes review text whose placeholders require English fallback', () => {
        expect(translationCoverage({ count: '{count} mods' }, { count: '? {name} Mods' })).toEqual({
            translated: 0,
            total: 1,
        })
    })

    it('includes a complete source bundle and discovers every bundled locale', () => {
        expect(Object.keys(TRANSLATION_COVERAGE)).toEqual(LOCALE_IDS)
        expect(TRANSLATION_COVERAGE.en.translated).toBe(TRANSLATION_COVERAGE.en.total)
        expect(TRANSLATION_COVERAGE.en.total).toBeGreaterThan(0)
    })

    it('keeps English complete when source strings resemble target markers', async () => {
        vi.resetModules()
        const source = { missing: '! ', pending: '? text' }
        vi.doMock('./i18n/en.json', () => ({ default: source }))
        vi.doMock('./locales', () => ({ LOCALE_IDS: ['en'], RAW_BUNDLES: { en: source } }))

        const { TRANSLATION_COVERAGE: coverage } = await import('./translationStatus')
        expect(coverage.en).toEqual({ translated: 2, total: 2 })
    })
})

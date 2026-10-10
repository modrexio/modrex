import { describe, it, expect } from 'vitest'
import type { GameSpec } from '@modrex/games'
import { isUnsupportedFormat } from './formatCheck'

const noResources: Pick<GameSpec, 'movieReplacement' | 'configPresets'> = {}
const movieOnly: typeof noResources = {
    movieReplacement: { extension: 'bk2', storefronts: ['steam'] },
}
const configOnly: typeof noResources = { configPresets: { filename: 'Engine.ini' } }

describe('isUnsupportedFormat', () => {
    describe('when type is provided', () => {
        it.each(['pak', 'zip', '7z', 'rar', 'pdmod'])(
            'returns false for supported type "%s"',
            (type) => {
                expect(isUnsupportedFormat(noResources, type)).toBe(false)
            }
        )

        it('is case-insensitive', () => {
            expect(isUnsupportedFormat(noResources, 'PAK')).toBe(false)
            expect(isUnsupportedFormat(noResources, 'ZIP')).toBe(false)
            expect(isUnsupportedFormat(noResources, '7Z')).toBe(false)
            expect(isUnsupportedFormat(noResources, 'RAR')).toBe(false)
            expect(isUnsupportedFormat(noResources, 'PDMOD')).toBe(false)
        })

        it.each(['exe', 'dll', 'txt', 'bak2'])('returns true for unsupported type "%s"', (type) => {
            expect(isUnsupportedFormat(noResources, type)).toBe(true)
        })

        it('ignores downloadUrl when type is present', () => {
            expect(isUnsupportedFormat(noResources, 'exe', 'https://example.com/mod.pak')).toBe(
                true
            )
            expect(isUnsupportedFormat(noResources, 'pak', 'https://example.com/mod.exe')).toBe(
                false
            )
        })
    })

    describe('when type is undefined', () => {
        it('keeps ordinary package URL inference independent of display labels', () => {
            expect(
                isUnsupportedFormat(
                    noResources,
                    undefined,
                    'https://example.com/mod.zip',
                    'Instructions.txt'
                )
            ).toBe(false)
            expect(
                isUnsupportedFormat(
                    noResources,
                    undefined,
                    'https://example.com/mod.zip',
                    'Intro.bk2'
                )
            ).toBe(false)
            expect(
                isUnsupportedFormat(
                    configOnly,
                    undefined,
                    'https://example.com/payload.exe',
                    'Engine.ini'
                )
            ).toBe(true)
        })
        it('returns false when no URL provided', () => {
            expect(isUnsupportedFormat(noResources, undefined)).toBe(false)
        })

        it.each([
            'https://cdn.example.com/mods/mod.pak',
            'https://cdn.example.com/mods/mod.zip',
            'https://cdn.example.com/mods/mod.7z',
            'https://cdn.example.com/mods/mod.rar',
            'https://cdn.example.com/mods/mod.pdmod',
        ])('returns false for supported URL extension: %s', (url) => {
            expect(isUnsupportedFormat(noResources, undefined, url)).toBe(false)
        })

        it.each([
            'https://cdn.example.com/mods/mod.tar.gz',
            'https://cdn.example.com/mods/mod.tar.xz',
        ])('returns false for tar double-extensions: %s', (url) => {
            expect(isUnsupportedFormat(noResources, undefined, url)).toBe(false)
        })

        it.each(['https://cdn.example.com/mods/mod.exe'])(
            'returns true for unsupported URL extension: %s',
            (url) => {
                expect(isUnsupportedFormat(noResources, undefined, url)).toBe(true)
            }
        )

        it('returns false for a URL with no file extension', () => {
            expect(isUnsupportedFormat(noResources, undefined, 'https://cdn.example.com/mod')).toBe(
                false
            )
        })

        it('returns false for a URL ending with a dot (no extension after it)', () => {
            expect(
                isUnsupportedFormat(noResources, undefined, 'https://cdn.example.com/mod.')
            ).toBe(false)
        })

        it('returns false for an invalid URL string', () => {
            expect(isUnsupportedFormat(noResources, undefined, 'not-a-url')).toBe(false)
        })
    })
})

describe('declared resource formats', () => {
    it('allows Bink movies independently of config presets', () => {
        expect(isUnsupportedFormat(movieOnly, 'bk2')).toBe(false)
        expect(isUnsupportedFormat(configOnly, 'bk2')).toBe(true)
        expect(isUnsupportedFormat(noResources, 'bk2')).toBe(true)
        expect(isUnsupportedFormat(movieOnly, undefined, 'https://example.com/Intro.bk2')).toBe(
            false
        )
    })

    it('allows the declared Engine.ini preset independently of movies', () => {
        const url = 'https://example.com/Engine.ini'
        expect(isUnsupportedFormat(configOnly, 'ini', url)).toBe(false)
        expect(isUnsupportedFormat(configOnly, undefined, url)).toBe(false)
        expect(isUnsupportedFormat(movieOnly, 'ini', url)).toBe(true)
        expect(isUnsupportedFormat(noResources, 'ini', url)).toBe(true)
    })

    it('warns about arbitrary INIs and unnamed INI downloads', () => {
        expect(isUnsupportedFormat(configOnly, 'ini', 'https://example.com/Game.ini')).toBe(true)
        expect(isUnsupportedFormat(configOnly, 'ini')).toBe(true)
    })

    it('reads the hosted filename before an editable file label', () => {
        const url = 'https://example.com/opaque?filename=Engine%2EINI'
        expect(isUnsupportedFormat(configOnly, 'ini', url, 'Performance preset')).toBe(false)
        expect(
            isUnsupportedFormat(configOnly, 'ini', 'https://example.com/opaque', 'Engine.ini')
        ).toBe(false)
        expect(
            isUnsupportedFormat(configOnly, undefined, 'https://example.com/opaque', 'Engine.ini')
        ).toBe(false)
        expect(
            isUnsupportedFormat(
                configOnly,
                'ini',
                'https://example.com/opaque?filename=Game.ini',
                'Engine.ini'
            )
        ).toBe(true)
    })
})

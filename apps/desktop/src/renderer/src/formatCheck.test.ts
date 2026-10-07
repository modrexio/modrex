import { describe, it, expect } from 'vitest'
import { isUnsupportedFormat } from './formatCheck'

describe('isUnsupportedFormat', () => {
    describe('when type is provided', () => {
        it.each(['pak', 'zip', '7z', 'rar', 'pdmod', 'bk2', 'ini'])(
            'returns false for supported type "%s"',
            (type) => {
                expect(isUnsupportedFormat(type)).toBe(false)
            }
        )

        it('is case-insensitive', () => {
            expect(isUnsupportedFormat('PAK')).toBe(false)
            expect(isUnsupportedFormat('ZIP')).toBe(false)
            expect(isUnsupportedFormat('7Z')).toBe(false)
            expect(isUnsupportedFormat('RAR')).toBe(false)
            expect(isUnsupportedFormat('PDMOD')).toBe(false)
        })

        it.each(['exe', 'dll', 'txt', 'bak2'])('returns true for unsupported type "%s"', (type) => {
            expect(isUnsupportedFormat(type)).toBe(true)
        })

        it('ignores downloadUrl when type is present', () => {
            expect(isUnsupportedFormat('exe', 'https://example.com/mod.pak')).toBe(true)
            expect(isUnsupportedFormat('pak', 'https://example.com/mod.exe')).toBe(false)
        })
    })

    describe('when type is undefined', () => {
        it('returns false when no URL provided', () => {
            expect(isUnsupportedFormat(undefined)).toBe(false)
        })

        it.each([
            'https://cdn.example.com/mods/mod.pak',
            'https://cdn.example.com/mods/mod.zip',
            'https://cdn.example.com/mods/mod.7z',
            'https://cdn.example.com/mods/mod.rar',
            'https://cdn.example.com/mods/mod.pdmod',
        ])('returns false for supported URL extension: %s', (url) => {
            expect(isUnsupportedFormat(undefined, url)).toBe(false)
        })

        it.each([
            'https://cdn.example.com/mods/mod.tar.gz',
            'https://cdn.example.com/mods/mod.tar.xz',
        ])('returns false for tar double-extensions: %s', (url) => {
            expect(isUnsupportedFormat(undefined, url)).toBe(false)
        })

        it.each(['https://cdn.example.com/mods/mod.exe'])(
            'returns true for unsupported URL extension: %s',
            (url) => {
                expect(isUnsupportedFormat(undefined, url)).toBe(true)
            }
        )

        it('returns false for a URL with no file extension', () => {
            expect(isUnsupportedFormat(undefined, 'https://cdn.example.com/mod')).toBe(false)
        })

        it('returns false for a URL ending with a dot (no extension after it)', () => {
            expect(isUnsupportedFormat(undefined, 'https://cdn.example.com/mod.')).toBe(false)
        })

        it('returns false for an invalid URL string', () => {
            expect(isUnsupportedFormat(undefined, 'not-a-url')).toBe(false)
        })
    })
})

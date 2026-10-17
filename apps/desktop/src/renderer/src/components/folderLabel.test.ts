import { describe, expect, it } from 'vitest'
import { folderLabel } from './folderLabel'

describe('folderLabel', () => {
    it('names each label in the package vocabulary', () => {
        expect(folderLabel({ tag: 'mods', labelKey: 'mods', labelName: null })).toBe('Mods')
        expect(folderLabel({ tag: 'paks', labelKey: 'legacyPaks', labelName: null })).toBe(
            'Legacy paks'
        )
        expect(folderLabel({ tag: 'ue4ss_mods', labelKey: 'loaderMods', labelName: 'UE4SS' })).toBe(
            'UE4SS mods'
        )
    })

    it('throws on a label outside the vocabulary', () => {
        expect(() => folderLabel({ tag: 'x', labelKey: 'unknown', labelName: null })).toThrow()
    })

    it('throws on a loader label that names no loader', () => {
        expect(() => folderLabel({ tag: 'x', labelKey: 'loaderMods', labelName: null })).toThrow()
    })
})

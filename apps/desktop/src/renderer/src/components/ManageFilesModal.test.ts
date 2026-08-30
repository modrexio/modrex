import { describe, it, expect } from 'vitest'
import { resolveGhostEntryIndex } from './ManageFilesModal'

describe('resolveGhostEntryIndex', () => {
    const collidingArchive = ['A/Mod.pak', 'B/Mod.pak']

    it('resolves an archive-sourced ghost to its own entry when basenames collide', () => {
        expect(resolveGhostEntryIndex(collidingArchive, 'B/Mod.pak')).toBe(1)
        expect(resolveGhostEntryIndex(collidingArchive, 'A/Mod.pak')).toBe(0)
    })

    it('is unaffected by archive enumeration order', () => {
        const reversed = ['B/Mod.pak', 'A/Mod.pak']
        expect(resolveGhostEntryIndex(reversed, 'B/Mod.pak')).toBe(0)
        expect(resolveGhostEntryIndex(reversed, 'A/Mod.pak')).toBe(1)
    })

    it('still resolves a ghost seeded from an installed file path or the index', () => {
        const archive = ['Inner/CoolMod.pak', 'Other.pak']
        expect(resolveGhostEntryIndex(archive, 'CoolMod.pak')).toBe(0)
        expect(resolveGhostEntryIndex(archive, 'MyFolder/CoolMod.pak')).toBe(0)
        expect(resolveGhostEntryIndex(archive, 'Other.pak')).toBe(1)
    })

    it('refuses a basename-only ghost that cannot name one entry', () => {
        expect(resolveGhostEntryIndex(collidingArchive, 'Mod.pak')).toBeNull()
        expect(resolveGhostEntryIndex(collidingArchive, 'Elsewhere/Mod.pak')).toBeNull()
    })

    it('refuses an entry the archive does not contain', () => {
        expect(resolveGhostEntryIndex(collidingArchive, 'Missing.pak')).toBeNull()
    })

    it('refuses display names that normalize onto each other', () => {
        expect(resolveGhostEntryIndex(['a/b.pak', 'a/b.pak'], 'a/b.pak')).toBeNull()
    })
})

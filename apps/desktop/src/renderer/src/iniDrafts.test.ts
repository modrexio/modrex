// @vitest-environment happy-dom
import { beforeEach, describe, it, expect } from 'vitest'
import type { IniEditorSession } from './api'
import { discardIniDraft, readIniDraft, writeIniDraft } from './iniDrafts'

const session: IniEditorSession = {
    sessionHandle: 'original',
    contextKey: 'original-context',
    gameId: 'pd3',
    gamePath: '/games/pd3',
    path: '/prefix/Engine.ini',
    text: '[Engine]\nKey=before\n',
    sha256: 'first',
    readOnly: false,
    readOnlyReason: null,
    exists: true,
}

beforeEach(() => localStorage.clear())

describe('INI draft ownership', () => {
    it('retains draft bytes and their base revision across reopened sessions', () => {
        writeIniDraft(session, {
            text: '; retained\n[Engine]\nKey=after\n',
            sha256: session.sha256,
        })
        const reopened = { ...session, sessionHandle: 'reopened', sha256: 'changed' }
        expect(readIniDraft(reopened)).toEqual({
            text: '; retained\n[Engine]\nKey=after\n',
            sha256: 'first',
        })
    })

    it('never retargets a draft after switching install, game, or config path', () => {
        writeIniDraft(session, { text: 'draft', sha256: 'first' })
        expect(readIniDraft({ ...session, gamePath: '/other/install' })).toBeNull()
        expect(readIniDraft({ ...session, gameId: 'cb' })).toBeNull()
        expect(readIniDraft({ ...session, path: '/other/prefix/Engine.ini' })).toBeNull()
        expect(readIniDraft({ ...session, contextKey: 'retargeted-install-or-store' })).toBeNull()
        expect(readIniDraft(session)?.text).toBe('draft')
    })

    it('preserves corrupt storage until the user explicitly discards it', () => {
        writeIniDraft(session, { text: 'draft', sha256: 'first' })
        const key = localStorage.key(0)!
        localStorage.setItem(key, '{"text":42}')
        expect(() => readIniDraft(session)).toThrow('preserved')
        expect(localStorage.getItem(key)).toBe('{"text":42}')
        discardIniDraft(session)
        expect(readIniDraft(session)).toBeNull()
    })
})

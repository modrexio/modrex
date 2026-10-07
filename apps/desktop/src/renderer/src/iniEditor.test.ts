import { describe, it, expect, vi } from 'vitest'
import { finishIniEditor, getIniEditor, showIniEditor } from './iniEditor'
import type { IniEditorSession } from './api'

const session: IniEditorSession = {
    sessionHandle: 'kept',
    contextKey: 'installation',
    gameId: 'pd3',
    gamePath: '/games/pd3',
    path: '/config/Engine.ini',
    text: 'unsaved context',
    sha256: 'before',
    exists: true,
    readOnly: false,
    readOnlyReason: null,
}

describe('application INI editor', () => {
    it('keeps the bound session outside the game workspace until its own close succeeds', () => {
        const closed = vi.fn()
        const reference = { name: 'Preset Engine.ini', text: '[Rendering]\nScale=2' }
        showIniEditor(session, reference, closed)
        expect(getIniEditor()?.session).toBe(session)
        expect(getIniEditor()?.reference).toBe(reference)
        expect(() =>
            showIniEditor({ ...session, sessionHandle: 'replacement', gameId: 'cb' })
        ).toThrow('Close the current')
        expect(getIniEditor()?.session).toBe(session)
        expect(() => finishIniEditor('another-session')).toThrow('session changed')
        expect(getIniEditor()?.session).toBe(session)
        expect(closed).not.toHaveBeenCalled()
        finishIniEditor(session.sessionHandle)
        expect(getIniEditor()).toBeNull()
        expect(closed).toHaveBeenCalledOnce()
    })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IniEditorDialog } from './IniEditorDialog'
import { api, type IniEditorSession } from '../api'
import { readIniDraft, writeIniDraft } from '../iniDrafts'

vi.mock('../api', () => ({
    api: {
        closeEngineIni: vi.fn(() => Promise.resolve()),
        recognizeResourceHash: vi.fn(() => Promise.resolve({ status: 'noMatch' })),
        saveEngineIni: vi.fn(),
        guardWindowClose: vi.fn(() => Promise.resolve(() => {})),
    },
}))

const session: IniEditorSession = {
    sessionHandle: 'bound-session',
    contextKey: 'bound-context',
    gameId: 'pd3',
    gamePath: '/games/original',
    path: '/config/Engine.ini',
    text: '; comment\n[Engine]\nKey=before\n',
    sha256: 'first',
    readOnly: false,
    readOnlyReason: null,
    exists: true,
}

beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
})
afterEach(cleanup)

describe('INI editor lifecycle', () => {
    it('retains the draft when closing the backend session fails during discard', async () => {
        vi.mocked(api.closeEngineIni).mockRejectedValueOnce(new Error('Session close failed.'))
        const close = vi.fn()
        render(<IniEditorDialog session={session} onClose={close} />)
        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: '[Engine]\nKey=unsaved\n' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('Session close failed')
        )
        expect(readIniDraft(session)?.text).toBe('[Engine]\nKey=unsaved\n')
        expect(close).not.toHaveBeenCalled()
    })

    it('keeps the draft on header dismissal and workspace remount', async () => {
        const close = vi.fn()
        const view = render(<IniEditorDialog session={session} onClose={close} />)
        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: '; keep\n[Engine]\nKey=after\n' },
        })
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
        await waitFor(() => expect(close).toHaveBeenCalled())
        expect(api.closeEngineIni).toHaveBeenCalledWith('bound-session')
        view.unmount()
        render(
            <IniEditorDialog
                session={{ ...session, sessionHandle: 'new-session' }}
                onClose={close}
            />
        )
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
            '; keep\n[Engine]\nKey=after\n'
        )
        expect(api.saveEngineIni).not.toHaveBeenCalled()
    })

    it('requires explicit review of a retained draft whose original file changed', async () => {
        writeIniDraft(session, { text: '[Engine]\nKey=draft\n', sha256: 'older' })
        render(<IniEditorDialog session={session} onClose={vi.fn()} />)
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            true
        )
        fireEvent.click(screen.getByRole('button', { name: 'Use draft after review' }))
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            false
        )
        expect(readIniDraft(session)?.sha256).toBe('present:first')
    })

    it('preserves a stale-save draft and the bound session on failure', async () => {
        vi.mocked(api.saveEngineIni).mockRejectedValueOnce(new Error('File changed since opening.'))
        render(<IniEditorDialog session={session} onClose={vi.fn()} />)
        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: '[Engine]\nKey=after\n' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('File changed'))
        expect(api.saveEngineIni).toHaveBeenCalledWith(
            'bound-session',
            '[Engine]\nKey=after\n',
            false
        )
        expect(readIniDraft(session)?.text).toBe('[Engine]\nKey=after\n')
    })
})

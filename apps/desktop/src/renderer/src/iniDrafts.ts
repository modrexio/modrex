import type { IniEditorSession } from './api'
import { t } from './i18n'

export interface IniDraft {
    sha256: string
    text: string
}

export function iniDraftRevision(session: IniEditorSession): string {
    return `${session.exists ? 'present' : 'absent'}:${session.sha256}`
}

function draftKey(session: IniEditorSession): string {
    return `modrex:ini-draft:${JSON.stringify([session.contextKey, session.gameId, session.gamePath, session.path])}`
}

export function readIniDraft(session: IniEditorSession): IniDraft | null {
    const raw = localStorage.getItem(draftKey(session))
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    if (
        typeof value !== 'object' ||
        value === null ||
        !('sha256' in value) ||
        typeof value.sha256 !== 'string' ||
        !('text' in value) ||
        typeof value.text !== 'string'
    ) {
        throw new Error(t('resources.editor.invalidDraft'))
    }
    return { sha256: value.sha256, text: value.text }
}

export function writeIniDraft(session: IniEditorSession, draft: IniDraft): void {
    localStorage.setItem(draftKey(session), JSON.stringify(draft))
}

export function discardIniDraft(session: IniEditorSession): void {
    localStorage.removeItem(draftKey(session))
}

import type { IniEditorSession } from './api'
import { t } from './i18n'

interface OpenEditor {
    session: IniEditorSession
    reference?: { name: string; text: string }
    onClose?: () => void
}

let editor: OpenEditor | null = null
const listeners = new Set<() => void>()

export function subscribeIniEditor(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getIniEditor(): OpenEditor | null {
    return editor
}

export function showIniEditor(
    session: IniEditorSession,
    reference?: { name: string; text: string },
    onClose?: () => void
): void {
    if (editor) throw new Error(t('resources.editor.closeFirst'))
    editor = { session, reference, onClose }
    for (const listener of listeners) listener()
}

export function finishIniEditor(handle: string): void {
    if (editor?.session.sessionHandle !== handle) throw new Error('INI editor session changed.')
    const onClose = editor.onClose
    editor = null
    for (const listener of listeners) listener()
    onClose?.()
}

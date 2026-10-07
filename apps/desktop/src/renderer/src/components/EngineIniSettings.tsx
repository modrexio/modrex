import { useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'
import { showIniEditor } from '../iniEditor'

export function EngineIniSettings({ activeGame }: { activeGame: GameId }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function open(pick: boolean, folder = false) {
        setBusy(true)
        setError(null)
        try {
            const session = await (pick
                ? api.pickEngineIni(
                      activeGame,
                      t(folder ? 'resources.editor.chooseFolder' : 'resources.editor.chooseFile'),
                      folder
                  )
                : api.openEngineIni(activeGame))
            if (!session) return
            try {
                showIniEditor(session)
            } catch (failure) {
                await api.closeEngineIni(session.sessionHandle)
                throw failure
            }
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    return (
        <SettingsSection
            title={t('resources.editor.title')}
            description={t('resources.editor.settingsDescription')}
        >
            <div className="flex gap-2">
                <Button variant="accent" size="sm" disabled={busy} onClick={() => void open(false)}>
                    {t('resources.editor.open')}
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void open(true, true)}
                >
                    {t('resources.editor.chooseFolder')}
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void open(true)}
                >
                    {t('resources.editor.chooseFile')}
                </Button>
            </div>
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
        </SettingsSection>
    )
}

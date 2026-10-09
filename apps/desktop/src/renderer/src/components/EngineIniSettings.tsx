import { useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { ConfigFileSettings } from './ConfigFileSettings'
import { Button } from './ui/Button'

export function EngineIniSettings({ activeGame }: { activeGame: GameId }) {
    const [error, setError] = useState<string | null>(null)
    return (
        <ConfigFileSettings
            activeGame={activeGame}
            getLocation={api.getEngineIniLocation}
            pickFile={api.pickEngineIni}
            openFile={api.openEngineIni}
            messages={{
                title: t('resources.config.title'),
                description: t('resources.config.description'),
                open: t('resources.config.open'),
                chooseFile: t('resources.config.chooseFile'),
                checking: t('resources.config.checking'),
                found: t('resources.config.found'),
                missing: t('resources.config.missing'),
                needsLocation: t('resources.config.needsLocation'),
                checkFailed: t('resources.config.checkFailed'),
                manualTools: t('resources.config.manualTools'),
            }}
        >
            <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                    setError(null)
                    void api.openDataFolder().catch((failure) => setError(String(failure)))
                }}
            >
                {t('resources.recovery.openCopies')}
            </Button>
            <p>{t('resources.recovery.copiesLocation')}</p>
            {error && (
                <p role="alert" className="text-danger-text">
                    {error}
                </p>
            )}
        </ConfigFileSettings>
    )
}

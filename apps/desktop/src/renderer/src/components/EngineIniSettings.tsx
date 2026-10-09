import { api } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { ConfigFileSettings } from './ConfigFileSettings'

export function EngineIniSettings({
    activeGame,
    gamePath,
    onOpenGameSettings,
}: {
    activeGame: GameId
    gamePath: string | null | undefined
    onOpenGameSettings: () => void
}) {
    return (
        <ConfigFileSettings
            activeGame={activeGame}
            gamePath={gamePath}
            onOpenGameSettings={onOpenGameSettings}
            getLocation={api.getEngineIniLocation}
            pickFile={api.pickEngineIni}
            openFile={api.openEngineIni}
            title={t('resources.config.title')}
            filename="Engine.ini"
        />
    )
}

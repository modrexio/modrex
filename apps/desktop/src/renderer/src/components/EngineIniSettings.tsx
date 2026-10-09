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
            messages={{
                title: t('resources.config.title'),
                description: t('resources.config.description'),
                open: t('resources.config.open'),
                chooseFile: t('resources.config.chooseFile'),
                checking: t('resources.config.checking'),
                found: t('resources.config.found'),
                missing: t('resources.config.missing'),
                missingHint: t('resources.config.missingHint'),
                needsLocation: t('resources.config.needsLocation'),
                checkFailed: t('resources.config.checkFailed'),
            }}
        />
    )
}

import type { GameId } from '../../../shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { ConfigFileSettings } from './ConfigFileSettings'

export function GraphicsConfigSettings({
    activeGame,
    gamePath,
    onOpenGameSettings,
    filename,
}: {
    activeGame: GameId
    gamePath: string | null | undefined
    onOpenGameSettings: () => void
    filename: string
}) {
    return (
        <ConfigFileSettings
            activeGame={activeGame}
            gamePath={gamePath}
            onOpenGameSettings={onOpenGameSettings}
            getLocation={api.getGraphicsConfigLocation}
            pickFile={api.pickGraphicsConfig}
            openFile={api.openGraphicsConfig}
            messages={{
                title: t('settings.graphicsConfig.title'),
                description: t('settings.graphicsConfig.description'),
                open: t('settings.graphicsConfig.open'),
                chooseFile: t('settings.graphicsConfig.chooseFile', { filename }),
                checking: t('settings.graphicsConfig.checking', { filename }),
                found: t('settings.graphicsConfig.found', { filename }),
                missing: t('settings.graphicsConfig.missing', { filename }),
                missingHint: t('resources.config.missingHint'),
                needsLocation: t('settings.graphicsConfig.needsLocation', { filename }),
                checkFailed: t('settings.graphicsConfig.checkFailed', { filename }),
            }}
        />
    )
}

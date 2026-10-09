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
            title={t('settings.graphicsConfig.title')}
            filename={filename}
        />
    )
}

import { GAME_SPECS } from './catalog.generated'
import type { GameSpec } from './types'

export { LAUNCHERS } from './types'
export type { GameSpec, LauncherName, ModTarget, ModTargetId } from './types'

export type GameId = keyof typeof GAME_SPECS

export const GAMES: Record<GameId, GameSpec> = GAME_SPECS

export const GAME_IDS = Object.keys(GAMES) as GameId[]

export function isGameId(value: string | null): value is GameId {
    return value !== null && Object.hasOwn(GAMES, value)
}

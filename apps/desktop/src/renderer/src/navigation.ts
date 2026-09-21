import { GAMES, isGameId, type GameId } from '../../shared/types'

export type GameView = 'browse' | 'installed' | 'news' | 'settings'
export type AppRoute =
    { kind: 'picker' } | { kind: 'global-settings' } | { kind: 'game'; gameId: GameId }

export function readAppRoute(): AppRoute {
    const scope = localStorage.getItem('modrex:scope')
    if (scope === 'global-settings') return { kind: 'global-settings' }
    if (scope === 'picker') return { kind: 'picker' }
    if (scope !== null && scope !== 'game') return { kind: 'picker' }
    if (scope === null && localStorage.getItem('modrex:on-welcome') === '1') {
        return { kind: 'picker' }
    }
    const gameId = localStorage.getItem('modrex:active-game')
    return isGameId(gameId) ? { kind: 'game', gameId } : { kind: 'picker' }
}

export function saveAppRoute(route: AppRoute) {
    localStorage.setItem('modrex:scope', route.kind)
    if (route.kind === 'game') {
        localStorage.setItem('modrex:active-game', route.gameId)
        localStorage.removeItem('modrex:on-welcome')
        return
    }
    localStorage.setItem('modrex:on-welcome', '1')
}

export function readGameView(gameId: GameId): GameView {
    const saved =
        localStorage.getItem(`modrex:${gameId}:view`) ?? localStorage.getItem('modrex:active-view')
    if (saved === 'news') return GAMES[gameId].hasNews ? 'news' : 'browse'
    return saved === 'installed' || saved === 'settings' ? saved : 'browse'
}

export function saveGameView(gameId: GameId, view: GameView) {
    localStorage.setItem(`modrex:${gameId}:view`, view)
}

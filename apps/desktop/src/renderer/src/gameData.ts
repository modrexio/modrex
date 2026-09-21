import type { GameId } from '../../shared/types'
import { api } from './api'

type Installed = Awaited<ReturnType<typeof api.getInstalled>>

interface GameData {
    path: string | null | undefined
    installed: Installed | undefined
}

const empty: GameData = { path: undefined, installed: undefined }
const cache = new Map<GameId, GameData>()
const listeners = new Map<GameId, Set<() => void>>()
const failedDetectAt = new Map<GameId, number>()
const pathRequests = new Map<GameId, number>()
const installedRequests = new Map<GameId, number>()
const DETECT_RETRY_MS = 5 * 60 * 1000

export function getGameData(gameId: GameId): GameData {
    return cache.get(gameId) ?? empty
}

export function subscribeGameData(gameId: GameId, listener: () => void) {
    const gameListeners = listeners.get(gameId) ?? new Set()
    listeners.set(gameId, gameListeners)
    gameListeners.add(listener)
    return () => {
        gameListeners.delete(listener)
    }
}

function updateGameData(gameId: GameId, patch: Partial<GameData>) {
    cache.set(gameId, { ...getGameData(gameId), ...patch })
    listeners.get(gameId)?.forEach((listener) => listener())
}

export function clearFailedDetection(gameId: GameId) {
    failedDetectAt.delete(gameId)
}

export async function refreshGamePath(gameId: GameId) {
    const failedAt = failedDetectAt.get(gameId)
    if (failedAt !== undefined && Date.now() - failedAt < DETECT_RETRY_MS) return
    const request = (pathRequests.get(gameId) ?? 0) + 1
    pathRequests.set(gameId, request)
    const path = await api.findGamePath(gameId)
    if (pathRequests.get(gameId) !== request) return
    if (path === null) failedDetectAt.set(gameId, Date.now())
    else failedDetectAt.delete(gameId)
    updateGameData(gameId, { path })
}

export async function refreshInstalled(gameId: GameId) {
    const request = (installedRequests.get(gameId) ?? 0) + 1
    installedRequests.set(gameId, request)
    const installed = await api.getInstalled(gameId)
    if (installedRequests.get(gameId) !== request) return
    if (JSON.stringify(getGameData(gameId).installed) === JSON.stringify(installed)) return
    updateGameData(gameId, { installed })
}

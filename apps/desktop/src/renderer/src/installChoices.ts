import { useSyncExternalStore } from 'react'
import type { GameId, InstalledMod } from '../../shared/types'
import type { InstallOutcome } from './api'
import { getPendingResourceReview, subscribeResourceReview } from './resourceInstall'

export interface InstallChoice {
    id: number
    outcome: Exclude<InstallOutcome, 'installed' | 'cancelled'>
    gameId: GameId
    gamePath: string
    installedFiles: InstalledMod[]
    folderId: string | null
    modId?: number
    cleanupError?: string
}

type PendingChoice = InstallChoice & {
    resolve: () => void
}
const queue: PendingChoice[] = []
const listeners = new Set<() => void>()
let nextId = 0

export function requestInstallChoice(
    outcome: InstallOutcome,
    gameId: GameId,
    gamePath: string,
    installedFiles: InstalledMod[] = [],
    folderId: string | null = null,
    modId?: number,
    cleanupError?: string
): Promise<void> {
    if (outcome === 'installed' || outcome === 'cancelled') return Promise.resolve()
    if (outcome === 'unrecognized' && modId === undefined)
        throw new Error('Unrecognized archive instructions need a mod ID.')
    return new Promise((resolve) => {
        queue.push({
            id: ++nextId,
            outcome,
            gameId,
            gamePath,
            installedFiles,
            folderId,
            modId,
            cleanupError,
            resolve,
        })
        for (const listener of listeners) listener()
    })
}

export function subscribeInstallChoices(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getPendingInstallChoice(): InstallChoice | null {
    return queue[0] ?? null
}

export function finishInstallChoice(choice: InstallChoice): void {
    if (queue[0]?.id !== choice.id) throw new Error('Archive choice order changed.')
    const pending = queue.shift()!
    pending.resolve()
    for (const listener of listeners) listener()
}

export function reportInstallChoiceCleanupError(choice: InstallChoice, error: string): void {
    if (queue[0]?.id !== choice.id) throw new Error('Archive choice order changed.')
    queue[0] = { ...queue[0], cleanupError: error }
    for (const listener of listeners) listener()
}

function subscribeReviews(listener: () => void): () => void {
    const stopChoices = subscribeInstallChoices(listener)
    const stopResources = subscribeResourceReview(listener)
    return () => {
        stopChoices()
        stopResources()
    }
}

function reviewOpen(): boolean {
    return queue.length > 0 || getPendingResourceReview() !== null
}

export function useInstallChoiceOpen(): boolean {
    return useSyncExternalStore(subscribeReviews, reviewOpen)
}

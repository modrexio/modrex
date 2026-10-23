import { useCallback, useSyncExternalStore } from 'react'
import { t } from './i18n'
import type { InstallOutcome } from './api'

export interface InstallTarget {
    gameId: string
    source: 'modworkshop' | 'nexus'
    modId: number
    fileId?: number
}

interface InstallOperationBase {
    id: number
    target: InstallTarget
    error?: string
    archiveHandle?: string
    reviewHandle?: string
}

type InstallPhase = 'awaitingNexus' | 'preparing' | 'installing' | 'review' | 'failed'

export type InstallOperation = InstallOperationBase &
    (
        | { phase: 'downloading'; downloaded: number; total: number }
        | { phase: InstallPhase; downloaded?: never; total?: never }
    )

type InstallPatch = Partial<Omit<InstallOperationBase, 'id'>> &
    ({ phase: 'downloading'; downloaded: number; total: number } | { phase?: InstallPhase })

const empty: readonly InstallOperation[] = []
const operations = new Map<string, readonly InstallOperation[]>()
const listeners = new Map<string, Set<() => void>>()
let nextId = 0

export function getInstallOperations(gameId: string): readonly InstallOperation[] {
    return operations.get(gameId) ?? empty
}

export function subscribeInstallOperations(gameId: string, listener: () => void): () => void {
    const gameListeners = listeners.get(gameId) ?? new Set()
    listeners.set(gameId, gameListeners)
    gameListeners.add(listener)
    return () => {
        gameListeners.delete(listener)
    }
}

function publish(gameId: string, value: readonly InstallOperation[]) {
    operations.set(gameId, value.length ? value : empty)
    listeners.get(gameId)?.forEach((listener) => listener())
}

export function useInstallOperations(gameId: string): readonly InstallOperation[] {
    const subscribe = useCallback(
        (listener: () => void) => subscribeInstallOperations(gameId, listener),
        [gameId]
    )
    const snapshot = useCallback(() => getInstallOperations(gameId), [gameId])
    return useSyncExternalStore(subscribe, snapshot)
}

export function isInstallBusy(
    operation: InstallOperation | undefined
): operation is InstallOperation {
    return operation !== undefined && operation.phase !== 'failed'
}

export function getModInstall(
    values: readonly InstallOperation[],
    source: string,
    modId: number,
    fileId?: number
): InstallOperation | undefined {
    const matching = values.filter(
        (operation) =>
            operation.target.source === source &&
            operation.target.modId === modId &&
            (fileId === undefined ||
                operation.target.fileId === undefined ||
                operation.target.fileId === fileId)
    )
    return matching.find(isInstallBusy) ?? matching[0]
}

export function beginInstall(
    target: InstallTarget,
    phase: 'preparing' | 'awaitingNexus' = 'preparing'
): InstallOperation {
    const current = getInstallOperations(target.gameId)
    const conflicting = current.find(
        (operation) =>
            isInstallBusy(operation) &&
            operation.target.source === target.source &&
            operation.target.modId === target.modId &&
            (operation.target.fileId === undefined ||
                target.fileId === undefined ||
                operation.target.fileId === target.fileId)
    )
    if (conflicting) throw new Error(t('common.installInProgress'))
    const operation: InstallOperation = { id: ++nextId, target, phase }
    publish(target.gameId, [
        ...current.filter(
            (value) =>
                value.phase !== 'failed' ||
                value.target.source !== target.source ||
                value.target.modId !== target.modId
        ),
        operation,
    ])
    return operation
}

export function updateInstall(id: number, patch: InstallPatch): void {
    for (const [gameId, current] of operations) {
        if (!current.some((operation) => operation.id === id)) continue
        publish(
            gameId,
            current.map((operation): InstallOperation => {
                if (operation.id !== id) return operation
                if (patch.phase === 'downloading') return { ...operation, ...patch }
                const { phase, ...fields } = patch
                if (phase === undefined) return { ...operation, ...fields }
                return { ...operation, ...fields, phase, downloaded: undefined, total: undefined }
            })
        )
        return
    }
}

export function finishInstall(id: number): void {
    for (const [gameId, current] of operations) {
        if (!current.some((operation) => operation.id === id)) continue
        publish(
            gameId,
            current.filter((operation) => operation.id !== id)
        )
        return
    }
}

export function clearInstallError(id: number): void {
    for (const current of operations.values()) {
        const operation = current.find((value) => value.id === id)
        if (!operation) continue
        if (operation.phase === 'failed') finishInstall(id)
        else updateInstall(id, { error: undefined })
        return
    }
}

export function getArchiveInstall(handle: string): InstallOperation | undefined {
    for (const current of operations.values()) {
        const operation = current.find((value) => value.archiveHandle === handle)
        if (operation) return operation
    }
    return undefined
}

export function failArchiveInstall(handle: string, error: unknown): void {
    const operation = getArchiveInstall(handle)
    if (operation) updateInstall(operation.id, { phase: 'failed', error: String(error) })
}

export function archiveHandleForOutcome(outcome: Exclude<InstallOutcome, string>): string
export function archiveHandleForOutcome(outcome: InstallOutcome): string | null
export function archiveHandleForOutcome(outcome: InstallOutcome): string | null {
    if (typeof outcome === 'string') return null
    const payload =
        outcome.needsPicker ??
        outcome.needsHostChoice ??
        outcome.needsCbFlatConfirm ??
        outcome.needsLoaderConfirm
    return payload.archiveHandle
}

export function getResourceInstall(handle: string): InstallOperation | undefined {
    for (const current of operations.values()) {
        const operation = current.find((value) => value.reviewHandle === handle)
        if (operation) return operation
    }
    return undefined
}

export function finishArchiveInstall(handle: string): void {
    const operation = getArchiveInstall(handle)
    if (!operation) return
    if (operation.reviewHandle) {
        updateInstall(operation.id, { archiveHandle: undefined, phase: 'review' })
        return
    }
    finishInstall(operation.id)
}

export function finishResourceInstall(handle: string): void {
    const operation = getResourceInstall(handle)
    if (operation) finishInstall(operation.id)
}

export function acceptNexusInstall(target: InstallTarget): InstallOperation {
    const current = getInstallOperations(target.gameId)
    const accepted = current.find(
        (operation) =>
            operation.target.source === 'nexus' &&
            operation.target.modId === target.modId &&
            operation.target.fileId === target.fileId &&
            isInstallBusy(operation) &&
            operation.phase !== 'awaitingNexus'
    )
    if (accepted) return accepted
    const awaiting = current.find(
        (operation): operation is InstallOperation & { phase: 'awaitingNexus' } =>
            operation.target.source === 'nexus' &&
            operation.target.modId === target.modId &&
            operation.phase === 'awaitingNexus' &&
            (operation.target.fileId === undefined || operation.target.fileId === target.fileId)
    )
    if (awaiting) {
        updateInstall(awaiting.id, { target, phase: 'preparing' })
        return { ...awaiting, target, phase: 'preparing' }
    }
    const operation: InstallOperation = { id: ++nextId, target, phase: 'preparing' }
    publish(target.gameId, [
        ...current.filter(
            (value) =>
                value.phase !== 'failed' ||
                value.target.source !== 'nexus' ||
                value.target.modId !== target.modId ||
                value.target.fileId !== target.fileId
        ),
        operation,
    ])
    return operation
}

/** The id Rust gives a ModWorkshop download, in the shape getDownloadInstall reads. */
export function modworkshopDownloadId(modId: number, fileId?: number): string {
    return fileId === undefined ? `mod:${modId}` : `file:${modId}:${fileId}`
}

export function getDownloadInstall(
    gameId: string,
    downloadId: string
): InstallOperation | undefined {
    const [prefix, first, second, third] = downloadId.split(':')
    if (prefix === 'nxm') {
        if (first !== gameId) return undefined
        return getModInstall(getInstallOperations(gameId), 'nexus', Number(second), Number(third))
    }
    if (prefix === 'mod') {
        return getModInstall(getInstallOperations(gameId), 'modworkshop', Number(first))
    }
    if (prefix === 'file') {
        return getModInstall(
            getInstallOperations(gameId),
            'modworkshop',
            Number(first),
            Number(second)
        )
    }
    return undefined
}

export function installProgress(
    operation: InstallOperation | undefined
): { downloaded: number; total: number } | null {
    if (operation?.phase !== 'downloading') return null
    return { downloaded: operation.downloaded, total: operation.total }
}

export function installLabel(operation: InstallOperation): string {
    if (operation.phase === 'awaitingNexus') return t('detail.downloads.awaitingNexus')
    if (operation.phase === 'preparing') return t('common.preparingInstall')
    if (operation.phase === 'review') return t('common.reviewInstall')
    if (operation.phase === 'failed') return t('common.installFailed')
    const progress = installProgress(operation)
    if (!progress) return t('common.installing')
    if (progress.total === 0) return t('common.downloading')
    return `${Math.round((progress.downloaded / progress.total) * 100)}%`
}

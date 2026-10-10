import { error as logError } from '@tauri-apps/plugin-log'
import type { GameId } from '../../shared/types'
import { api, type PendingGameLaunch, type SisrLaunchIssue } from './api'
import { refreshInstalled } from './gameData'
import { t } from './i18n'

type LaunchMode = 'modded' | 'vanilla'
interface LaunchState {
    running: boolean
    launching: LaunchMode | null
    pending: PendingGameLaunch | null
    error: string | null
    warning: SisrLaunchIssue | null
}
interface LaunchSession {
    state: LaunchState
    listeners: Set<() => void>
    timer: ReturnType<typeof setTimeout> | null
    checking: boolean
    pendingRestore: boolean
    operationPending: boolean
    request: number
}

const empty: LaunchState = {
    running: false,
    launching: null,
    pending: null,
    error: null,
    warning: null,
}
const sessions = new Map<GameId, LaunchSession>()

function sessionFor(gameId: GameId): LaunchSession {
    const existing = sessions.get(gameId)
    if (existing) return existing
    const session: LaunchSession = {
        state: empty,
        listeners: new Set(),
        timer: null,
        checking: false,
        pendingRestore: false,
        operationPending: false,
        request: 0,
    }
    sessions.set(gameId, session)
    return session
}

export function getLaunchState(gameId: GameId): LaunchState {
    return sessions.get(gameId)?.state ?? empty
}

function update(session: LaunchSession, patch: Partial<LaunchState>) {
    session.state = { ...session.state, ...patch }
    session.listeners.forEach((listener) => listener())
}

function reportError(session: LaunchSession, error: unknown) {
    update(session, { error: String(error) })
    void logError('Game launch operation failed: ' + String(error))
}

function schedule(gameId: GameId, session: LaunchSession) {
    if (
        session.listeners.size === 0 &&
        !session.pendingRestore &&
        !session.operationPending &&
        !session.state.launching &&
        !session.state.pending
    ) {
        if (session.timer) clearTimeout(session.timer)
        session.timer = null
        return
    }
    if (session.timer || session.checking) return
    session.timer = setTimeout(() => {
        session.timer = null
        void check(gameId, session)
    }, 3000)
}

async function check(gameId: GameId, session: LaunchSession) {
    if (session.checking) return
    session.checking = true
    const current = session.request
    try {
        const { running, pending } = await api.getGameLaunchStatus(gameId)
        if (current !== session.request) return
        if (session.operationPending && !running) return
        const stopped = session.state.running && !running
        const launching = running || !pending ? null : session.state.launching
        if (
            session.state.running !== running ||
            session.state.pending !== pending ||
            session.state.launching !== launching
        )
            update(session, { running, pending, launching })
        if (running || pending) return
        const refresh = stopped || session.pendingRestore
        if (session.pendingRestore) {
            session.pendingRestore = false
            await api.restoreMods(gameId)
        }
        if (refresh) await refreshInstalled(gameId)
    } catch (error) {
        if (current === session.request) reportError(session, error)
    } finally {
        session.checking = false
        schedule(gameId, session)
    }
}

export function subscribeLaunchState(gameId: GameId, listener: () => void) {
    const session = sessionFor(gameId)
    session.listeners.add(listener)
    void check(gameId, session)
    return () => {
        session.listeners.delete(listener)
        schedule(gameId, session)
    }
}

async function refreshLaunchFailure(gameId: GameId, failure: unknown): Promise<unknown> {
    try {
        await refreshInstalled(gameId)
        return failure
    } catch (refreshFailure) {
        return `${String(failure)}\n${String(refreshFailure)}`
    }
}

export async function launchGame(gameId: GameId, mode: LaunchMode) {
    const session = sessionFor(gameId)
    if (session.operationPending) {
        reportError(session, t('topBar.launchOperationPending'))
        return
    }
    session.request += 1
    session.operationPending = true
    update(session, { launching: mode, pending: 'preparing', error: null, warning: null })
    try {
        const warning =
            mode === 'vanilla'
                ? await api.launchWithoutMods(gameId)
                : await api.launchModded(gameId)
        session.pendingRestore = mode === 'vanilla'
        update(session, { warning })
    } catch (error) {
        update(session, { launching: null, pending: null })
        reportError(session, await refreshLaunchFailure(gameId, error))
    } finally {
        session.request += 1
        session.operationPending = false
        schedule(gameId, session)
    }
}

export async function resetPendingLaunch(gameId: GameId) {
    const session = sessionFor(gameId)
    if (session.operationPending) throw new Error(t('topBar.launchOperationPending'))
    session.request += 1
    session.operationPending = true
    try {
        try {
            await api.cancelPendingGameLaunch(gameId)
        } catch (error) {
            const failure = await refreshLaunchFailure(gameId, error)
            reportError(session, failure)
            throw failure
        }
        session.pendingRestore = false
        update(session, { running: false, launching: null, pending: null, error: null })
        try {
            await refreshInstalled(gameId)
        } catch (error) {
            reportError(session, error)
        }
    } finally {
        session.request += 1
        session.operationPending = false
        schedule(gameId, session)
    }
}

export async function stopGame(gameId: GameId) {
    try {
        await api.stopGame(gameId)
    } catch (error) {
        reportError(sessionFor(gameId), error)
    }
}

export function dismissLaunchError(gameId: GameId) {
    update(sessionFor(gameId), { error: null })
}

export function dismissLaunchWarning(gameId: GameId) {
    update(sessionFor(gameId), { warning: null })
}

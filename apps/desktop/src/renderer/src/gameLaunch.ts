import { error as logError } from '@tauri-apps/plugin-log'
import type { GameId } from '../../shared/types'
import { api, type SisrLaunchIssue } from './api'
import { refreshInstalled } from './gameData'

type LaunchMode = 'modded' | 'vanilla'
interface LaunchState {
    running: boolean
    launching: LaunchMode | null
    error: string | null
    warning: SisrLaunchIssue | null
}
interface LaunchSession {
    state: LaunchState
    listeners: Set<() => void>
    timer: ReturnType<typeof setTimeout> | null
    checking: boolean
    pendingRestore: boolean
    launchPending: boolean
    startedAt: number | null
    missedChecks: number
}

const empty: LaunchState = { running: false, launching: null, error: null, warning: null }
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
        launchPending: false,
        startedAt: null,
        missedChecks: 0,
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
    update(session, { error: String(error), launching: null })
    void logError('Game launch operation failed: ' + String(error))
}

function schedule(gameId: GameId, session: LaunchSession) {
    if (session.timer || session.checking) return
    if (
        session.listeners.size === 0 &&
        !session.pendingRestore &&
        !session.launchPending &&
        !session.state.launching
    )
        return
    session.timer = setTimeout(() => {
        session.timer = null
        void check(gameId, session)
    }, 3000)
}

async function check(gameId: GameId, session: LaunchSession) {
    if (session.checking) return
    session.checking = true
    try {
        const running = await api.isGameRunning(gameId)
        if (session.launchPending && !running) return
        const stopped = session.state.running && !running
        const timedOut = session.startedAt !== null && Date.now() - session.startedAt >= 60_000
        if (session.state.running !== running) update(session, { running })
        if (!running && session.state.launching) session.missedChecks++
        if (running || timedOut || session.missedChecks >= 3) {
            session.startedAt = null
            if (session.state.launching) update(session, { launching: null })
        }
        if (!stopped) return
        session.startedAt = null
        if (session.pendingRestore) {
            session.pendingRestore = false
            await api.restoreMods(gameId)
        }
        await refreshInstalled(gameId)
    } catch (error) {
        reportError(session, error)
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
        if (
            session.listeners.size ||
            session.pendingRestore ||
            session.launchPending ||
            session.state.launching
        )
            return
        if (session.timer) clearTimeout(session.timer)
        session.timer = null
    }
}

export async function launchGame(gameId: GameId, mode: LaunchMode) {
    const session = sessionFor(gameId)
    session.launchPending = true
    session.startedAt = Date.now()
    session.missedChecks = 0
    update(session, { launching: mode, error: null, warning: null })
    try {
        const warning =
            mode === 'vanilla'
                ? await api.launchWithoutMods(gameId)
                : await api.launchModded(gameId)
        session.pendingRestore = mode === 'vanilla'
        update(session, { warning })
    } catch (error) {
        session.startedAt = null
        reportError(session, error)
    } finally {
        session.launchPending = false
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

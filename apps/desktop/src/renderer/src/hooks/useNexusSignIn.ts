import { useSyncExternalStore } from 'react'
import { api } from '../api'

export type NexusSignInStatus = 'idle' | 'awaiting' | 'finishing' | 'interrupted'

let snapshot: { status: NexusSignInStatus; error: string | null } = {
    status: 'idle',
    error: null,
}
const listeners = new Set<() => void>()
let stopListening: (() => void) | undefined
let focusTimer: ReturnType<typeof setTimeout> | undefined

function update(status: NexusSignInStatus, error: string | null = null) {
    clearTimeout(focusTimer)
    snapshot = { status, error }
    for (const listener of listeners) listener()
}

function onFocus() {
    if (snapshot.status !== 'awaiting') return
    clearTimeout(focusTimer)
    // The single instance plugin in lib.rs also focuses a successful handoff.
    // Allow its callback to arrive before treating the return as interrupted.
    focusTimer = setTimeout(() => {
        if (snapshot.status === 'awaiting') update('interrupted')
    }, 2000)
}

function subscribe(listener: () => void) {
    if (!stopListening) {
        const offCallbackReceived = api.onNexusOAuthCallbackReceived(() => {
            update('finishing', snapshot.error)
        })
        const offFailed = api.onNexusOAuthFailed((message) => update('idle', message))
        const offSignedIn = api.onNexusOAuthSignedIn(() => update('idle'))
        window.addEventListener('focus', onFocus)
        stopListening = () => {
            offCallbackReceived()
            offFailed()
            offSignedIn()
            window.removeEventListener('focus', onFocus)
        }
    }
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function getSnapshot() {
    return snapshot
}

async function signIn() {
    update('awaiting')
    try {
        await api.nexusOAuthStart()
    } catch (error) {
        update('idle', String(error))
    }
}

// Test support for isolating the shared state and subscriptions between cases.
export function resetNexusSignInForTests() {
    stopListening?.()
    stopListening = undefined
    update('idle')
}

export function useNexusSignIn() {
    const { status, error } = useSyncExternalStore(subscribe, getSnapshot)
    return { status, error, signIn }
}

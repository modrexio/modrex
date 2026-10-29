import { useSyncExternalStore } from 'react'

export const CORNER_RADIUS_MIN = 0
export const CORNER_RADIUS_MAX = 10

const CORNER_RADIUS_STORAGE_KEY = 'modrex:corner-radius'
const DEFAULT_CORNER_RADIUS = 4

function readSavedCornerRadius(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_CORNER_RADIUS
    const raw = localStorage.getItem(CORNER_RADIUS_STORAGE_KEY)
    if (raw === null) return DEFAULT_CORNER_RADIUS
    const saved = Number(raw)
    return Number.isInteger(saved) && saved >= CORNER_RADIUS_MIN && saved <= CORNER_RADIUS_MAX
        ? saved
        : DEFAULT_CORNER_RADIUS
}

function applyCornerRadius(radius: number): void {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--modrex-radius', `${radius}px`)
}

let activeCornerRadius = readSavedCornerRadius()
const listeners = new Set<() => void>()

export function initCornerRadius(): void {
    applyCornerRadius(activeCornerRadius)
}

export function getCornerRadius(): number {
    return activeCornerRadius
}

export function setCornerRadius(radius: number): void {
    if (radius === activeCornerRadius) return
    activeCornerRadius = radius
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CORNER_RADIUS_STORAGE_KEY, String(radius))
    }
    applyCornerRadius(radius)
    for (const listener of listeners) listener()
}

export function subscribeCornerRadius(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

export function useCornerRadius(): number {
    return useSyncExternalStore(subscribeCornerRadius, getCornerRadius)
}

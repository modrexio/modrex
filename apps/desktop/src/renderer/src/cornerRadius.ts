import { useSyncExternalStore } from 'react'

// The scale multiplies every corner radius the design declares, so 1 is the design itself.
// It is stored rather than a pixel value so a redesign with different radii keeps each
// user's preference meaning the same thing. index.css owns the radii and their ceilings.
export const DEFAULT_CORNER_SCALE = 1
// At this scale the tallest controls, about 34px, reach half their height and turn into pills.
export const MAX_CORNER_SCALE = 4.5

export const CORNER_POSITION_MAX = 100
export const DEFAULT_CORNER_POSITION = CORNER_POSITION_MAX / 2

const CORNER_SCALE_STORAGE_KEY = 'modrex:corner-scale'

// The default sits mid-bar, so the left half spans sharp to default and the right half
// spans default to the maximum. A linear bar would leave the default near the left end.
export function cornerScaleFromPosition(position: number): number {
    const half = DEFAULT_CORNER_POSITION
    const scale =
        position <= half
            ? (position / half) * DEFAULT_CORNER_SCALE
            : DEFAULT_CORNER_SCALE +
              ((position - half) / half) * (MAX_CORNER_SCALE - DEFAULT_CORNER_SCALE)
    return Math.round(scale * 100) / 100
}

export function cornerPositionFromScale(scale: number): number {
    const half = DEFAULT_CORNER_POSITION
    const position =
        scale <= DEFAULT_CORNER_SCALE
            ? (scale / DEFAULT_CORNER_SCALE) * half
            : half +
              ((scale - DEFAULT_CORNER_SCALE) / (MAX_CORNER_SCALE - DEFAULT_CORNER_SCALE)) * half
    return Math.round(position)
}

function readSavedCornerScale(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_CORNER_SCALE
    const raw = localStorage.getItem(CORNER_SCALE_STORAGE_KEY)
    if (raw === null || raw === '') return DEFAULT_CORNER_SCALE
    const saved = Number(raw)
    return Number.isFinite(saved) && saved >= 0 && saved <= MAX_CORNER_SCALE
        ? saved
        : DEFAULT_CORNER_SCALE
}

function applyCornerScale(scale: number): void {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--modrex-radius-scale', String(scale))
}

let activeCornerScale = readSavedCornerScale()
const listeners = new Set<() => void>()

export function initCornerScale(): void {
    applyCornerScale(activeCornerScale)
}

export function getCornerScale(): number {
    return activeCornerScale
}

export function setCornerScale(scale: number): void {
    if (scale === activeCornerScale) return
    activeCornerScale = scale
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CORNER_SCALE_STORAGE_KEY, String(scale))
    }
    applyCornerScale(scale)
    for (const listener of listeners) listener()
}

export function subscribeCornerScale(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

export function useCornerScale(): number {
    return useSyncExternalStore(subscribeCornerScale, getCornerScale)
}

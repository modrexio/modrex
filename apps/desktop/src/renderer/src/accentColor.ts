import { useSyncExternalStore } from 'react'

export const ACCENT_COLORS = {
    orange: { swatch: '#c45500' },
    purple: { swatch: '#874cf9' },
    green: { swatch: '#189346' },
    blue: { swatch: '#1a71f9' },
    red: { swatch: '#e21c23' },
    gray: { swatch: '#7b7b7b' },
} as const

export type AccentColor = keyof typeof ACCENT_COLORS

const ACCENT_COLOR_STORAGE_KEY = 'modrex:accent-color'
const DEFAULT_ACCENT_COLOR: AccentColor = 'orange'

function isAccentColor(value: string | null): value is AccentColor {
    return value !== null && Object.prototype.hasOwnProperty.call(ACCENT_COLORS, value)
}

function readSavedAccentColor(): AccentColor {
    if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_COLOR
    const saved = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)
    return isAccentColor(saved) ? saved : DEFAULT_ACCENT_COLOR
}

function applyAccentColor(color: AccentColor): void {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.accent = color
}

let activeAccentColor = readSavedAccentColor()
const listeners = new Set<() => void>()

export function initAccentColor(): void {
    applyAccentColor(activeAccentColor)
}

export function getAccentColor(): AccentColor {
    return activeAccentColor
}

export function setAccentColor(color: AccentColor): void {
    if (color === activeAccentColor) return
    activeAccentColor = color
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, color)
    }
    applyAccentColor(color)
    for (const listener of listeners) listener()
}

export function subscribeAccentColor(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

export function useAccentColor(): AccentColor {
    return useSyncExternalStore(subscribeAccentColor, getAccentColor)
}

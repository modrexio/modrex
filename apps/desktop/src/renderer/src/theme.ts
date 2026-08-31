import { useSyncExternalStore } from 'react'
import { isGameId, type GameId } from '../../shared/types'

// Accent themes selectable in Settings. The fill hex drives the colour swatch in
// the picker; both mirror the matching :root[data-theme] override in index.css.
export const THEMES = {
    purple: { accent: '#9771f7', fill: '#7c3aed' },
    orange: { accent: '#e36300', fill: '#c45500' },
    green: { accent: '#4ade80', fill: '#15803d' },
    blue: { accent: '#60a5fa', fill: '#2563eb' },
    red: { accent: '#f87171', fill: '#dc2626' },
    darkRed: { accent: '#ef4444', fill: '#b91c1c' },
} as const

export type ThemeId = keyof typeof THEMES

// 'auto' follows the active game's preset colour; any ThemeId is a manual override.
export type ThemeMode = 'auto' | ThemeId

export const GAME_THEMES: Record<GameId, ThemeId> = {
    pd3: 'green',
    pd2: 'blue',
    pdth: 'red',
    cb: 'orange',
    raid: 'darkRed',
}

const THEME_MODE_STORAGE_KEY = 'modrex:theme-mode'
const ACTIVE_GAME_STORAGE_KEY = 'modrex:active-game'
const DEFAULT_MODE: ThemeMode = 'auto'
const NO_GAME_THEME: ThemeId = 'purple'

function isThemeMode(value: string | null): value is ThemeMode {
    return (
        value !== null && (value === 'auto' || Object.prototype.hasOwnProperty.call(THEMES, value))
    )
}

function readStoredGame(): GameId | null {
    if (typeof localStorage === 'undefined') return null
    const saved = localStorage.getItem(ACTIVE_GAME_STORAGE_KEY)
    return isGameId(saved) ? saved : null
}

function resolveTheme(mode: ThemeMode, game: GameId | null): ThemeId {
    if (mode === 'auto') return game ? GAME_THEMES[game] : NO_GAME_THEME
    return mode
}

function applyTheme(theme: ThemeId): void {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme
}

function readSavedMode(): ThemeMode {
    if (typeof localStorage === 'undefined') return DEFAULT_MODE
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY)
    return isThemeMode(saved) ? saved : DEFAULT_MODE
}

let activeMode: ThemeMode = readSavedMode()
let lastKnownGame: GameId | null = readStoredGame()
let appliedTheme: ThemeId = resolveTheme(activeMode, lastKnownGame)

// Applies the resolved theme before first paint; called by both window entries.
export function initTheme(): void {
    applyTheme(appliedTheme)
}

const listeners = new Set<() => void>()

export function getThemeMode(): ThemeMode {
    return activeMode
}

// The ThemeId currently applied to the document.
export function getTheme(): ThemeId {
    return appliedTheme
}

export function setThemeMode(mode: ThemeMode): void {
    if (mode === activeMode) return
    activeMode = mode
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_MODE_STORAGE_KEY, mode)
    applyResolved()
    for (const listener of listeners) listener()
}

function applyResolved(): void {
    const theme = resolveTheme(activeMode, lastKnownGame)
    if (theme === appliedTheme) return
    appliedTheme = theme
    applyTheme(theme)
}

// App calls this whenever the active game changes so an 'auto' theme follows it.
export function syncThemeForGame(game: GameId): void {
    lastKnownGame = game
    if (activeMode !== 'auto') return
    const before = appliedTheme
    applyResolved()
    if (appliedTheme !== before) {
        for (const listener of listeners) listener()
    }
}

export function subscribeTheme(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

export function useThemeMode(): ThemeMode {
    return useSyncExternalStore(subscribeTheme, getThemeMode)
}

export const LAUNCHERS = ['Steam', 'Epic Games', 'Xbox App'] as const

export type LauncherName = (typeof LAUNCHERS)[number]
export type StorefrontId = 'steam' | 'epic' | 'xbox'
// Every target tag a package declares, generated so a new target needs no edit here.
export type { ModTargetId } from './catalog.generated.js'
import type { ModTargetId } from './catalog.generated.js'

export interface ModTarget {
    id: ModTargetId
    path: string
}

export interface GameSpec {
    name: string
    shortName: string
    modMetadata: 'diesel' | 'none'
    // Absent for a game that is not listed on modworkshop.
    workshopId?: number
    // Nexus's domain slug for this game, e.g. "payday3". Absent for games with no
    // Nexus presence (RAID).
    nexusDomain?: string
    storageKey: string
    hasNews: boolean
    supportsPackageViewer: boolean
    // False where mods are laid over the game folder, which has no place for app folders.
    appFolders: boolean
    movieReplacement?: {
        extensions: readonly ('bk2' | 'mp4')[]
        storefronts: readonly StorefrontId[]
    }
    configPresets?: {
        filename: 'Engine.ini'
    }
    graphicsConfig?: {
        filename: string
    }
    requiredLaunchFlag?: string
    launchers: readonly LauncherName[]
    modTargets: readonly ModTarget[]
}

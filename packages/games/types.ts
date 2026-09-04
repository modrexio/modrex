export const LAUNCHERS = ['Steam', 'Epic Games', 'Xbox App'] as const

export type LauncherName = (typeof LAUNCHERS)[number]
export type ModTargetId = 'mods' | 'paks' | 'ue4ss_mods' | 'mod_overrides'

export interface ModTarget {
    id: ModTargetId
    path: string
}

export interface GameSpec {
    name: string
    shortName: string
    // Absent for a game that is not listed on modworkshop.
    workshopId?: number
    // Nexus's domain slug for this game, e.g. "payday3". Absent for games with no
    // Nexus presence (RAID).
    nexusDomain?: string
    storageKey: string
    hasNews: boolean
    supportsPackageViewer: boolean
    requiredLaunchFlag?: string
    launchers: readonly LauncherName[]
    modTargets: readonly ModTarget[]
}

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
    workshopId: number
    // Nexus's domain slug for this game, e.g. "payday3". Absent for games with no
    // Nexus presence (RAID). Cross-checked against the Rust SOURCE_REGISTRY by
    // check-sources.mjs, same as workshopId.
    nexusDomain?: string
    storageKey: string
    hasNews: boolean
    requiredLaunchFlag?: string
    launchers: readonly LauncherName[]
    modTargets: readonly ModTarget[]
}

const GAME_SPECS = {
    pd3: {
        name: 'PAYDAY 3',
        shortName: 'PD3',
        workshopId: 853,
        nexusDomain: 'payday3',
        storageKey: 'pd3',
        hasNews: true,
        requiredLaunchFlag: '-fileopenlog',
        launchers: ['Steam', 'Epic Games', 'Xbox App'],
        modTargets: [
            { id: 'paks', path: 'PAYDAY3/Content/Paks/~mods' },
            { id: 'ue4ss_mods', path: 'PAYDAY3/Binaries/Win64/Mods' },
        ],
    },
    pd2: {
        name: 'PAYDAY 2',
        shortName: 'PD2',
        workshopId: 1,
        nexusDomain: 'payday2',
        storageKey: 'pd2',
        hasNews: true,
        launchers: ['Steam', 'Epic Games'],
        modTargets: [
            { id: 'mods', path: 'mods' },
            { id: 'mod_overrides', path: 'assets/mod_overrides' },
        ],
    },
    pdth: {
        name: 'PAYDAY: The Heist',
        shortName: 'PDTH',
        workshopId: 2,
        nexusDomain: 'paydaytheheist',
        storageKey: 'pdth',
        hasNews: true,
        launchers: ['Steam'],
        modTargets: [
            { id: 'mods', path: 'mods' },
            { id: 'mod_overrides', path: 'assets/mod_overrides' },
        ],
    },
    cb: {
        name: 'Crime Boss: Rockay City',
        shortName: 'CBRC',
        workshopId: 857,
        nexusDomain: 'crimebossrockaycity',
        storageKey: 'cb',
        hasNews: false,
        launchers: ['Steam', 'Epic Games'],
        modTargets: [
            { id: 'mods', path: 'CrimeBoss/Mods' },
            { id: 'paks', path: 'CrimeBoss/Content/Paks/~mods' },
            { id: 'ue4ss_mods', path: 'CrimeBoss/Binaries/Win64/Mods' },
        ],
    },
    raid: {
        name: 'RAID: World War II',
        shortName: 'RAID',
        workshopId: 543,
        storageKey: 'raid',
        hasNews: false,
        launchers: ['Steam'],
        modTargets: [{ id: 'mods', path: 'mods' }],
    },
} satisfies Record<string, GameSpec>

export type GameId = keyof typeof GAME_SPECS

export const GAMES: Record<GameId, GameSpec> = GAME_SPECS

export const GAME_IDS = Object.keys(GAMES) as GameId[]

export function isGameId(value: string | null): value is GameId {
    return value !== null && Object.hasOwn(GAMES, value)
}

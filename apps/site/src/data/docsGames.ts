import { GAME_IDS, type GameId, type ModTargetId } from '@modrex/games'

export interface CanonicalDocsTarget {
    label: string
    targetId: ModTargetId
    notes: string
}

export interface SupplementalDocsTarget {
    label: string
    path: string
    pathIsCode?: boolean
    notes: string
}

export type DocsTarget = CanonicalDocsTarget | SupplementalDocsTarget

export interface DocsGameRegistration {
    slug: string
    targets: readonly DocsTarget[]
}

export const docsGameRegistry = {
    pd3: {
        slug: 'payday-3',
        targets: [
            {
                label: 'Pak mods',
                targetId: 'paks',
                notes: 'Primary target for pak files. Disabled files are kept under disabled with a .disabled suffix.',
            },
            {
                label: 'UE4SS mods',
                targetId: 'ue4ss_mods',
                notes: 'Used for Lua mods when UE4SS is installed. Modrex excludes bundled UE4SS framework modules from the installed list.',
            },
        ],
    },
    pd2: {
        slug: 'payday-2',
        targets: [
            {
                label: 'BLT and BeardLib mods',
                targetId: 'mods',
                notes: 'Modrex recognizes folders with mod.txt or main.xml.',
            },
            {
                label: 'Asset replacements',
                targetId: 'mod_overrides',
                notes: 'Marker-less folders are routed here when they match the mod_overrides layout.',
            },
            {
                label: 'Host mod packs',
                path: 'Inside the host mod folder',
                pathIsCode: false,
                notes: 'Some packs install inside another mod, such as Menu Backgrounds packs. Modrex tracks these separately.',
            },
        ],
    },
    pdth: {
        slug: 'payday-the-heist',
        targets: [
            {
                label: 'BLT and DAHM mods',
                targetId: 'mods',
                notes: 'Modrex recognizes BLT folders with mod.txt and DAHM sub-mods with base.lua when they match the mod index.',
            },
            {
                label: 'Asset replacements',
                targetId: 'mod_overrides',
                notes: 'Marker-less asset replacement folders are routed here.',
            },
        ],
    },
    cb: {
        slug: 'crime-boss',
        targets: [
            {
                label: 'Official ModKit mods',
                targetId: 'mods',
                notes: 'Primary target for new installs. Modrex creates the expected folder structure around extracted files when needed.',
            },
            {
                label: 'Legacy pak mods',
                targetId: 'paks',
                notes: 'Used for pre-existing loose pak installs and loose-triplet mods.',
            },
            {
                label: 'UE4SS mods',
                targetId: 'ue4ss_mods',
                notes: 'Used for Lua mods when UE4SS is installed. Bundled UE4SS framework modules are excluded from the installed list.',
            },
        ],
    },
    raid: {
        slug: 'raid-world-war-ii',
        targets: [
            {
                label: 'RAID mods',
                targetId: 'mods',
                notes: 'RAID-SuperBLT, legacy RaidBLT script mods, and asset override packs share the game’s mods folder.',
            },
        ],
    },
} as const satisfies Record<GameId, DocsGameRegistration>

export type DocsGameId = GameId

export interface DocsGame extends DocsGameRegistration {
    id: DocsGameId
}

export const docsGames = GAME_IDS.map((id) => ({ id, ...docsGameRegistry[id] }))

export function getDocsGame(id: DocsGameId): DocsGame {
    const game = docsGames.find((candidate) => candidate.id === id)

    if (!game) {
        throw new Error(`Unknown docs game: ${id}`)
    }

    return game
}

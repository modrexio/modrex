// Generated from apps/desktop/src-tauri/src/games/<id>/package.toml. Do not edit.

import type { GameSpec } from './types.js'

export const GAME_SPECS = {
    cb: {
        name: 'Crime Boss: Rockay City',
        shortName: 'CBRC',
        modMetadata: 'none',
        workshopId: 857,
        nexusDomain: 'crimebossrockaycity',
        storageKey: 'cb',
        hasNews: false,
        supportsPackageViewer: true,
        movieReplacement: { extension: 'bk2', storefronts: ['steam', 'epic'] },
        configPresets: { filename: 'Engine.ini' },
        launchers: ['Steam', 'Epic Games'],
        modTargets: [
            { id: 'mods', path: 'CrimeBoss/Mods' },
            { id: 'paks', path: 'CrimeBoss/Content/Paks/~mods' },
            { id: 'ue4ss_mods', path: 'CrimeBoss/Binaries/Win64/Mods' },
        ],
    },
    pd2: {
        name: 'PAYDAY 2',
        shortName: 'PD2',
        modMetadata: 'diesel',
        workshopId: 1,
        nexusDomain: 'payday2',
        storageKey: 'pd2',
        hasNews: true,
        supportsPackageViewer: false,
        launchers: ['Steam', 'Epic Games'],
        modTargets: [
            { id: 'mods', path: 'mods' },
            { id: 'mod_overrides', path: 'assets/mod_overrides' },
        ],
    },
    pd3: {
        name: 'PAYDAY 3',
        shortName: 'PD3',
        modMetadata: 'none',
        workshopId: 853,
        nexusDomain: 'payday3',
        storageKey: 'pd3',
        hasNews: true,
        supportsPackageViewer: true,
        movieReplacement: { extension: 'bk2', storefronts: ['steam', 'epic'] },
        configPresets: { filename: 'Engine.ini' },
        launchers: ['Steam', 'Epic Games', 'Xbox App'],
        modTargets: [
            { id: 'paks', path: 'PAYDAY3/Content/Paks/~mods' },
            { id: 'ue4ss_mods', path: 'PAYDAY3/Binaries/Win64/UE4SS/Mods' },
        ],
    },
    pdth: {
        name: 'PAYDAY: The Heist',
        shortName: 'PDTH',
        modMetadata: 'diesel',
        workshopId: 2,
        nexusDomain: 'paydaytheheist',
        storageKey: 'pdth',
        hasNews: true,
        supportsPackageViewer: false,
        launchers: ['Steam'],
        modTargets: [
            { id: 'mods', path: 'mods' },
            { id: 'mod_overrides', path: 'assets/mod_overrides' },
        ],
    },
    raid: {
        name: 'RAID: World War II',
        shortName: 'RAID',
        modMetadata: 'diesel',
        workshopId: 543,
        storageKey: 'raid',
        hasNews: false,
        supportsPackageViewer: false,
        launchers: ['Steam'],
        modTargets: [
            { id: 'mods', path: 'mods' },
        ],
    },
} satisfies Record<string, GameSpec>

import { readFileSync } from 'fs'

// A game is registered twice by necessity: GAME_REGISTRY in Rust (engine config +
// storefront def) and @modrex/games (shared UI/index metadata). Neither side can see the
// other, so adding a game to one and forgetting the other compiles fine and fails at
// runtime: the renderer sends a game id the backend rejects as unknown, or the picker
// silently omits a supported game. This check diffs the two id lists.

const rust = readFileSync('src-tauri/src/commands/games.rs', 'utf8')
const registryBlock = rust.match(/GAME_REGISTRY: &\[GameSpec\] = &\[([\s\S]*?)\n\];/)?.[1]
if (!registryBlock) {
    console.error('check-games: GAME_REGISTRY not found in src-tauri/src/commands/games.rs')
    process.exit(1)
}
const rustIds = [...registryBlock.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1])

const ts = readFileSync('../../packages/games/index.ts', 'utf8')
const specsBlock = ts.match(/const GAME_SPECS = \{([\s\S]*?)\n\} satisfies/)?.[1]
if (!specsBlock) {
    console.error('check-games: GAMES not found in packages/games/index.ts')
    process.exit(1)
}
const tsIds = [...specsBlock.matchAll(/^ {4}(\w+):\s*\{/gm)].map((m) => m[1])

const gameFiles = {
    pd3: 'pd3',
    pd2: 'pd2',
    pdth: 'pdth',
    cb: 'crimeboss',
    raid: 'raid',
}
const launcherFields = [
    ['Steam', 'steam'],
    ['Epic Games', 'epic'],
    ['Xbox App', 'xbox'],
]
const engineNames = { pd3: 'PD3', pd2: 'PD2', pdth: 'PDTH', cb: 'CRIMEBOSS', raid: 'RAID' }
const engineSource = readFileSync('src-tauri/src/commands/mods/engine.rs', 'utf8')

const missingInTs = rustIds.filter((id) => !tsIds.includes(id))
const missingInRust = tsIds.filter((id) => !rustIds.includes(id))

let failed = false
if (missingInTs.length > 0) {
    failed = true
    console.error('Games in Rust GAME_REGISTRY but missing from GAMES (packages/games):')
    for (const id of missingInTs) console.error(`  ${id}`)
}
if (missingInRust.length > 0) {
    failed = true
    console.error('Games in GAMES (packages/games) but missing from Rust GAME_REGISTRY:')
    for (const id of missingInRust) console.error(`  ${id}`)
}

for (const id of tsIds) {
    const spec = specsBlock.split(new RegExp(`^ {4}${id}:\\s*\\{`, 'm'))[1]
    const declared = spec?.match(/launchers:\s*\[([^\]]*)\]/)?.[1]
    const sharedLaunchers = [...(declared?.matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1])
    const rustGame = readFileSync(
        `src-tauri/src/commands/launchers/games/${gameFiles[id]}.rs`,
        'utf8'
    )
    const rustLaunchers = launcherFields
        .filter(([, field]) => new RegExp(`\\b${field}:\\s*Some`).test(rustGame))
        .map(([name]) => name)

    if (sharedLaunchers.join('|') !== rustLaunchers.join('|')) {
        failed = true
        console.error(
            `Launcher support for '${id}' differs: Rust has ${rustLaunchers.join(', ') || 'none'}; ` +
                `@modrex/games has ${sharedLaunchers.join(', ') || 'none'}`
        )
    }

    const targetsBlock = spec?.match(/modTargets:\s*\[([\s\S]*?)\],/)?.[1]
    const sharedTargets = [
        ...(targetsBlock?.matchAll(/id: '([^']+)', path: '([^']+)'/g) ?? []),
    ].map((match) => `${match[1]}:${match[2]}`)
    const engine = engineSource.match(
        new RegExp(`pub static ${engineNames[id]}_ENGINE[\\s\\S]*?(?=\\npub static|\\npub fn)`)
    )?.[0]
    const rustTargets = [
        ...(engine?.matchAll(/tag:\s*"([^"]+)",[\s\S]*?mods_subpath:\s*&\[([^\]]*)\]/g) ?? []),
    ].map(
        (match) =>
            `${match[1]}:${[...match[2].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join('/')}`
    )
    if (sharedTargets.join('|') !== rustTargets.join('|')) {
        failed = true
        console.error(`Mod targets for '${id}' differ between Rust and @modrex/games`)
    }
}

if (failed) process.exit(1)
console.log(`check-games: ${rustIds.length} games, Rust and TypeScript registries agree`)

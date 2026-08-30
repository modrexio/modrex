import { readdirSync, readFileSync } from 'fs'

// A game is registered twice by necessity: the Rust backend (a discovered game package) and
// @modrex/games (shared UI/index metadata). Neither side can see the other, so adding a game
// to one and forgetting the other compiles fine and fails at runtime: the renderer sends a
// game id the backend rejects as unknown, or the picker silently omits a supported game.
// This check diffs the two id lists and the facts they both carry.

const PACKAGE_ROOT = 'src-tauri/src/games'

const rustIds = readdirSync(PACKAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

const ts = readFileSync('../../packages/games/index.ts', 'utf8')
const specsBlock = ts.match(/const GAME_SPECS = \{([\s\S]*?)\n\} satisfies/)?.[1]
if (!specsBlock) {
    console.error('check-games: GAMES not found in packages/games/index.ts')
    process.exit(1)
}
const tsIds = [...specsBlock.matchAll(/^ {4}(\w+):\s*\{/gm)].map((m) => m[1])

const launcherFields = [
    ['Steam', 'steam'],
    ['Epic Games', 'epic'],
    ['Xbox App', 'xbox'],
]

function match(source, pattern) {
    return source.match(pattern)?.[1]
}

/** The Rust text declaring this game's storefronts and mod targets. */
function backendSource(id) {
    return readFileSync(`${PACKAGE_ROOT}/${id}/package.rs`, 'utf8')
}

const missingInTs = rustIds.filter((id) => !tsIds.includes(id))
const missingInRust = tsIds.filter((id) => !rustIds.includes(id))

let failed = false
if (missingInTs.length > 0) {
    failed = true
    console.error('Games registered in Rust but missing from GAMES (packages/games):')
    for (const id of missingInTs) console.error(`  ${id}`)
}
if (missingInRust.length > 0) {
    failed = true
    console.error('Games in GAMES (packages/games) but not registered in Rust:')
    for (const id of missingInRust) console.error(`  ${id}`)
}

for (const id of tsIds) {
    const spec = specsBlock.split(new RegExp(`^ {4}${id}:\\s*\\{`, 'm'))[1]
    const declared = spec?.match(/launchers:\s*\[([^\]]*)\]/)?.[1]
    const sharedLaunchers = [...(declared?.matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1])
    const source = backendSource(id)
    const rustLaunchers = launcherFields
        .filter(([, field]) => new RegExp(`\\b${field}:\\s*Some`).test(source))
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
    const rustTargets = [
        ...source.matchAll(/tag:\s*"([^"]+)"[\s\S]*?mods_subpath:[^[]*\[([^\]]*)\]/g),
    ].map(
        (match) =>
            `${match[1]}:${[...match[2].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join('/')}`
    )
    if (sharedTargets.join('|') !== rustTargets.join('|')) {
        failed = true
        console.error(`Mod targets for '${id}' differ between Rust and @modrex/games`)
    }

    for (const [label, shared, rust] of [
        [
            'Short name',
            spec?.match(/shortName:\s*'([^']*)'/)?.[1],
            match(source, /short_name:\s*"([^"]*)"/),
        ],
        [
            'Required launch flag',
            spec?.match(/requiredLaunchFlag:\s*'([^']*)'/)?.[1] ?? 'none',
            match(source, /required_launch_flag:\s*Some\("([^"]*)"/) ?? 'none',
        ],
        [
            'News availability',
            String(spec?.match(/hasNews:\s*(true|false)/)?.[1] === 'true'),
            String(/news:\s*Some\(NewsBinding/.test(source)),
        ],
        ['Storage key', spec?.match(/storageKey:\s*'([^']*)'/)?.[1], id],
    ]) {
        if (shared !== rust) {
            failed = true
            console.error(
                `${label} for '${id}' differs: Rust has '${rust}'; @modrex/games has '${shared}'`
            )
        }
    }
}

if (failed) process.exit(1)
console.log(`check-games: ${rustIds.length} games, Rust and TypeScript registries agree`)

import { readFileSync } from 'fs'

// Both modworkshop's per-game id and Nexus's per-game domain are registered twice by
// necessity: SOURCE_REGISTRY in Rust, and workshopId/nexusDomain in @modrex/games. Neither
// side can see the other, so adding a game to one and forgetting the other compiles fine
// and fails at runtime. This check diffs both.
//
// The desktop renderer itself reads Nexus's domain from the registry over IPC
// (sources.ts) and never touches @modrex/games' nexusDomain - but apps/site has no IPC
// (it is a static build, not a Tauri app) and reads nexusDomain directly to query Nexus's
// mod counts at build time, so that copy is real, and diffed here the same way workshopId
// already is.

const rust = readFileSync('src-tauri/src/commands/sources.rs', 'utf8')
const registryBlock = rust.match(/SOURCE_REGISTRY: &\[SourceSpec\] = &\[([\s\S]*?)\n\];/)?.[1]
if (!registryBlock) {
    console.error('check-sources: SOURCE_REGISTRY not found in src-tauri/src/commands/sources.rs')
    process.exit(1)
}

// Each SourceSpec is an id line followed by its games array, so splitting on the id
// lines attributes every SourceGame block to the source it sits under.
const rustSources = new Map()
for (const chunk of registryBlock.split(/\bid:\s*"/).slice(1)) {
    const sourceId = chunk.slice(0, chunk.indexOf('"'))
    const pairs = [...chunk.matchAll(/game_id:\s*"([^"]+)"\s*,\s*native_id:\s*"([^"]+)"/g)].map(
        (m) => [m[1], m[2]]
    )
    rustSources.set(sourceId, new Map(pairs))
}

const ts = readFileSync('../../packages/games/index.ts', 'utf8')
const specsBlock = ts.match(/const GAME_SPECS = \{([\s\S]*?)\n\} satisfies/)?.[1]
if (!specsBlock) {
    console.error('check-sources: GAMES not found in packages/games/index.ts')
    process.exit(1)
}

// One entry per game, carrying workshopId and nexusDomain.
const tsWorkshop = new Map()
const tsNexus = new Map()
for (const chunk of specsBlock.split(/^ {4}(?=\w+:\s*\{)/m)) {
    const gameId = chunk.match(/^(\w+):\s*\{/)?.[1]
    if (!gameId) continue
    const workshopId = chunk.match(/workshopId:\s*(\d+)/)?.[1]
    if (workshopId) tsWorkshop.set(gameId, workshopId)
    const nexusDomain = chunk.match(/nexusDomain:\s*'([^']+)'/)?.[1]
    if (nexusDomain) tsNexus.set(gameId, nexusDomain)
}

const errors = []

function diff(sourceId, tsMap) {
    const rustMap = rustSources.get(sourceId)
    if (!rustMap) {
        errors.push(`source '${sourceId}' is missing from the Rust SOURCE_REGISTRY`)
        return
    }
    for (const [gameId, native] of rustMap) {
        if (!tsMap.has(gameId)) {
            errors.push(`${sourceId}: Rust maps '${gameId}' but @modrex/games does not`)
            continue
        }
        if (tsMap.get(gameId) !== native) {
            errors.push(
                `${sourceId}: '${gameId}' is '${native}' in Rust but '${tsMap.get(gameId)}' in @modrex/games`
            )
        }
    }
    for (const gameId of tsMap.keys()) {
        if (!rustMap.has(gameId)) {
            errors.push(
                `${sourceId}: @modrex/games maps '${gameId}' but the Rust registry does not`
            )
        }
    }
}

diff('modworkshop', tsWorkshop)
diff('nexus', tsNexus)

if (errors.length > 0) {
    console.error('Source registry disagrees between Rust and TypeScript:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
}

console.log(
    `check-sources: ${tsWorkshop.size} modworkshop and ${tsNexus.size} nexus game mappings agree between Rust and TypeScript`
)

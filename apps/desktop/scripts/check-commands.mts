import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// The renderer-to-Rust command channel is generated: collect_commands! in lib.rs
// drives src/shared/bindings.ts, and api.ts calls the generated commands.* functions.
// The payload shapes are typed end to end, but an unused command still compiles on
// both sides, so this check diffs the registered list against api.ts usage. It also
// enforces that api.ts stays the only renderer file that talks to the invoke API
// (directly or through the generated bindings).

const camelToSnake = (name: string) => name.replace(/([A-Z])/g, '_$1').toLowerCase()

const librs = readFileSync('src-tauri/src/lib.rs', 'utf8')
const handlerBlock = librs.match(/collect_commands!\[([\s\S]*?)\]/)?.[1]
if (!handlerBlock) {
    console.error('check-commands: collect_commands![...] not found in src-tauri/src/lib.rs')
    process.exit(1)
}
const registered = new Set([...handlerBlock.matchAll(/(?:\w+::)+(\w+)/g)].map((m) => m[1]!))

const bindings = readFileSync('src/shared/bindings.ts', 'utf8')
const bound = new Set(
    [...bindings.matchAll(/__TAURI_INVOKE(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]!)
)

const apiTs = readFileSync('src/renderer/src/api.ts', 'utf8')
const invoked = new Set([...apiTs.matchAll(/\bcommands\.(\w+)\(/g)].map((m) => camelToSnake(m[1]!)))

const missing = [...invoked].filter((name) => !registered.has(name))
const unused = [...registered].filter((name) => !invoked.has(name))
const stale = [...registered].filter((name) => !bound.has(name))

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(path)
        else if (/\.tsx?$/.test(entry.name)) yield path
    }
}

const strayImports: string[] = []
for (const path of walk('src/renderer/src')) {
    if (path.replace(/\\/g, '/') === 'src/renderer/src/api.ts') continue
    if (/\.test\.tsx?$/.test(path)) continue
    // convertFileSrc imports are fine (thumbnailCache.ts); only invoke is api.ts-only
    const source = readFileSync(path, 'utf8')
    if (/import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*'@tauri-apps\/api\/core'/.test(source)) {
        strayImports.push(path)
    }
    if (/from\s*'[^']*shared\/bindings'/.test(source)) {
        strayImports.push(path)
    }
}

let failed = false
if (missing.length > 0) {
    failed = true
    console.error('Commands called in api.ts but not registered in collect_commands! (lib.rs):')
    for (const name of missing) console.error(`  ${name}`)
}
if (unused.length > 0) {
    failed = true
    console.error('Commands registered in collect_commands! (lib.rs) but never called in api.ts:')
    for (const name of unused) console.error(`  ${name}`)
}
if (stale.length > 0) {
    failed = true
    console.error(
        'Commands registered in collect_commands! (lib.rs) but absent from src/shared/bindings.ts (regenerate with: cd src-tauri && cargo test --test export_bindings):'
    )
    for (const name of stale) console.error(`  ${name}`)
}
if (strayImports.length > 0) {
    failed = true
    console.error('Renderer files reaching the invoke API outside api.ts:')
    for (const path of strayImports) console.error(`  ${path}`)
}

if (failed) process.exit(1)
console.log(`check-commands: ${invoked.size} commands, registration and usage agree`)

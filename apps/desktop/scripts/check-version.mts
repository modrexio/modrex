import { readFileSync } from 'fs'

function fail(message: string): never {
    console.error(`Version check failed: ${message}`)
    process.exit(1)
}

function capture(contents: string, pattern: RegExp, source: string) {
    const match = contents.match(pattern)
    if (!match) fail(`could not read the version from ${source}`)
    return match[1]!
}

type Versioned = { version: string }

const readVersion = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as Versioned).version

const packageVersion = readVersion('package.json')
const rootPackageVersion = readVersion('../../package.json')
const tauriVersion = readVersion('src-tauri/tauri.conf.json')
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8')
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8')

const cargoVersion = capture(
    cargoToml,
    /^\[package\]\r?\n[\s\S]*?^version = "([^"]+)"$/m,
    'src-tauri/Cargo.toml'
)
const lockVersion = capture(
    cargoLock,
    /^\[\[package\]\]\r?\nname = "modrex"\r?\nversion = "([^"]+)"$/m,
    'src-tauri/Cargo.lock'
)

const versions = {
    '../../package.json': rootPackageVersion,
    'package.json': packageVersion,
    'src-tauri/tauri.conf.json': tauriVersion,
    'src-tauri/Cargo.toml': cargoVersion,
    'src-tauri/Cargo.lock': lockVersion,
}

for (const [source, version] of Object.entries(versions)) {
    if (version !== packageVersion) {
        fail(`${source} has ${version}, expected ${packageVersion}`)
    }
}

const tag = process.argv[2]
if (tag && tag !== `v${packageVersion}`) {
    fail(`release tag is ${tag}, expected v${packageVersion}`)
}

console.log(`Version check passed: ${packageVersion}${tag ? ` (${tag})` : ''}`)

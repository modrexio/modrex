import { readFileSync } from 'node:fs'

// Manifest/config drift silently disables updates for every installed client. Keep this
// check coupled to the release workflow so CI catches that drift before publishing.

const VALID_TARGETS = new Set([
    'linux-x86_64-deb',
    'linux-x86_64-rpm',
    'linux-x86_64-appimage',
    'windows-x86_64',
    'windows-i686',
    'windows-aarch64',
    'darwin-x86_64',
    'darwin-aarch64',
])
const REQUIRED_TARGETS = [
    'windows-x86_64',
    'linux-x86_64-deb',
    'linux-x86_64-rpm',
    'linux-x86_64-appimage',
]

type TauriConf = {
    plugins?: { updater?: { endpoints?: unknown; pubkey?: unknown } }
    bundle?: {
        createUpdaterArtifacts?: unknown
        linux?: {
            deb?: { conflicts?: string[]; replaces?: string[] }
            rpm?: { obsoletes?: string[] }
        }
    }
}

const problems: string[] = []

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as TauriConf
const updater = conf.plugins?.updater ?? {}
const endpoints: unknown[] = Array.isArray(updater.endpoints) ? updater.endpoints : []
if (endpoints.length === 0) {
    problems.push('tauri.conf.json plugins.updater.endpoints is missing or empty')
}
const manifestEndpoint = endpoints.find(
    (e): e is string => typeof e === 'string' && e.endsWith('latest.json')
)
if (endpoints.length > 0 && !manifestEndpoint) {
    problems.push('no plugins.updater.endpoints entry points at a latest.json manifest')
}
if (typeof updater.pubkey !== 'string' || updater.pubkey.length === 0) {
    problems.push('tauri.conf.json plugins.updater.pubkey is missing or empty')
}
if (conf.bundle?.createUpdaterArtifacts !== true) {
    problems.push(
        'tauri.conf.json bundle.createUpdaterArtifacts must be true (updater needs .sig artifacts)'
    )
}
if (!conf.bundle?.linux?.deb?.conflicts?.includes('pd3-mod-manager')) {
    problems.push('tauri.conf.json bundle.linux.deb.conflicts must include pd3-mod-manager')
}
if (!conf.bundle?.linux?.deb?.replaces?.includes('pd3-mod-manager')) {
    problems.push('tauri.conf.json bundle.linux.deb.replaces must include pd3-mod-manager')
}
if (!conf.bundle?.linux?.rpm?.obsoletes?.includes('pd3-mod-manager')) {
    problems.push('tauri.conf.json bundle.linux.rpm.obsoletes must include pd3-mod-manager')
}

const build = readFileSync('../../.github/workflows/desktop-build.yml', 'utf8')
const release = readFileSync('../../.github/workflows/release.yml', 'utf8')
const nightly = readFileSync('../../.github/workflows/nightly.yml', 'utf8')
const updaterSource = readFileSync('src-tauri/src/commands/updater.rs', 'utf8')

function checkManifest(workflow: string, source: string) {
    if (!/>\s*latest\.json\b/.test(source)) {
        problems.push(
            `${workflow} does not generate latest.json (no "> latest.json" redirect found)`
        )
    }

    const jqFilter = source.match(/'(\{\s*version:[\s\S]*?\})'/)?.[1]
    if (!jqFilter) {
        problems.push(`${workflow}: could not find the jq object template that builds latest.json`)
        return
    }
    for (const key of ['version', 'platforms', 'signature', 'url']) {
        if (!jqFilter.includes(key)) {
            problems.push(`${workflow} latest.json template is missing the "${key}" field`)
        }
    }
    const platformKeys = [...jqFilter.matchAll(/"((?:windows|linux|darwin)-[a-z0-9_-]+)"/g)].map(
        (m) => m[1]!
    )
    for (const key of platformKeys) {
        if (!VALID_TARGETS.has(key)) {
            problems.push(`${workflow} latest.json uses unknown updater target "${key}"`)
        }
    }
    for (const target of REQUIRED_TARGETS) {
        if (!platformKeys.includes(target)) {
            problems.push(`${workflow} latest.json is missing the "${target}" platform`)
        }
    }
    if (!source.includes('minisign -V')) {
        problems.push(`${workflow} does not verify final updater artifacts with minisign`)
    }
}

checkManifest('release.yml', release)
checkManifest('nightly.yml', nightly)

if (!build.includes('run: bun run build:signed')) {
    problems.push(
        'desktop-build.yml must build with bun run build:signed (plain bun run build skips Authenticode)'
    )
}
if (!build.includes('tauri signer sign --app-version')) {
    problems.push('desktop-build.yml must sign updater artifacts with --app-version')
}
for (const signaturePattern of [
    'bundle/deb/*.sig',
    'bundle/rpm/*.sig',
    'bundle/appimage/*.sig',
    'bundle/nsis/*.sig',
]) {
    if (!build.includes(signaturePattern)) {
        problems.push(
            `desktop-build.yml does not upload updater signatures matching ${signaturePattern}`
        )
    }
}
for (const artifact of [
    'modrex_x86_64.exe',
    'modrex_x86_64.deb',
    'modrex_x86_64.rpm',
    'modrex_x86_64.AppImage',
]) {
    if (!release.includes(artifact)) {
        problems.push(`release.yml does not produce the stable updater artifact ${artifact}`)
    }
}
for (const extension of ['exe', 'deb', 'rpm', 'AppImage']) {
    if (!nightly.includes(`.${extension}`)) {
        problems.push(`nightly.yml does not publish a .${extension} artifact`)
    }
}
if (!build.includes('minisign -V')) {
    problems.push('desktop-build.yml does not verify final updater artifacts with minisign')
}
for (const postSignMutation of ['dpkg-deb -R', 'rpmbuild -bb']) {
    if (build.includes(postSignMutation)) {
        problems.push(`desktop-build.yml mutates signed packages with ${postSignMutation}`)
    }
}

const publishIdx = release.indexOf('Publish release')
if (publishIdx === -1) {
    problems.push('release.yml has no "Publish release" step')
} else if (!/^\s*latest\.json\s*$/m.test(release.slice(publishIdx))) {
    problems.push('release.yml does not publish latest.json in the release files list')
}
if (!nightly.includes('gh release upload nightly latest.json')) {
    problems.push('nightly.yml does not publish latest.json')
}
if (!nightly.includes('--prerelease') || !nightly.includes('-F prerelease=true')) {
    problems.push('nightly.yml must publish the nightly release as a pre-release')
}

if (manifestEndpoint) {
    const base = manifestEndpoint.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//)?.[1]
    if (base && !release.includes(`${base}/releases/`)) {
        problems.push(`release.yml download URLs do not match the updater endpoint repo (${base})`)
    }
    if (base && !nightly.includes(`${base}/releases/download/nightly`)) {
        problems.push(`nightly.yml download URLs do not match the updater endpoint repo (${base})`)
    }
    if (base && !updaterSource.includes(`${base}/releases/download/nightly/latest.json`)) {
        problems.push(
            `updater.rs nightly endpoint does not match the updater endpoint repo (${base})`
        )
    }
}

if (problems.length > 0) {
    console.error('check-updater: updater manifest generation and config disagree:')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
}
console.log('check-updater: latest.json generation and tauri.conf.json updater config agree')

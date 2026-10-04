import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function fail(message) {
    console.error(message)
    process.exit(1)
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const rootPackagePath = fileURLToPath(new URL('../../../package.json', import.meta.url))
const desktopPackagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const tauriConfigPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url))
const cargoManifestPath = fileURLToPath(new URL('../src-tauri/Cargo.toml', import.meta.url))
const changelogPath = fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url))

const increments = ['patch', 'minor', 'major']
const increment = process.argv[2]
if (process.argv.length !== 3 || !increments.includes(increment)) {
    fail('Usage: bun release patch|minor|major')
}

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()

const rootPackage = readFileSync(rootPackagePath, 'utf8')
const desktopPackage = readFileSync(desktopPackagePath, 'utf8')
const conf = readFileSync(tauriConfigPath, 'utf8')
const cargo = readFileSync(cargoManifestPath, 'utf8')
const changelog = readFileSync(changelogPath, 'utf8')

const oldVersion = JSON.parse(rootPackage).version
const versions = {
    desktop: JSON.parse(desktopPackage).version,
    tauri: JSON.parse(conf).version,
    cargo: cargo.match(/^version = "([^"]+)"$/m)?.[1],
}
for (const [name, version] of Object.entries(versions)) {
    if (version !== oldVersion) {
        fail(`Release versions must agree before bumping: root=${oldVersion}, ${name}=${version}`)
    }
}

const parts = oldVersion
    .match(/^(\d+)\.(\d+)\.(\d+)$/)
    ?.slice(1)
    .map(Number)
if (!parts) fail(`Root version ${oldVersion} is not a plain major.minor.patch version`)
const [major, minor, patch] = parts
const version = {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
}[increment]
const tag = `v${version}`

if (git('tag', '--list', tag)) fail(`Release tag ${tag} already exists`)

const status = git('status', '--porcelain=v1', '--untracked-files=no')
if (status) fail(`Tracked files must be clean before creating a desktop release:\n${status}`)

if (!changelog.includes('## Unreleased\n')) fail('CHANGELOG.md has no Unreleased section')
const unreleasedBody = changelog.match(/## Unreleased\n([\s\S]*?)\n## /)?.[1].trim()
if (!unreleasedBody) {
    console.warn(
        `Warning: CHANGELOG.md Unreleased section is empty — ${tag} will ship with no release notes.`
    )
}

const bump = (text) => text.replace(`"version": "${oldVersion}"`, `"version": "${version}"`)
writeFileSync(rootPackagePath, bump(rootPackage))
writeFileSync(desktopPackagePath, bump(desktopPackage))
writeFileSync(tauriConfigPath, bump(conf))
writeFileSync(
    cargoManifestPath,
    cargo.replace(`version = "${oldVersion}"`, `version = "${version}"`)
)
writeFileSync(
    changelogPath,
    changelog.replace(/## Unreleased\n+/, `## Unreleased\n\n## ${version}\n\n`)
)

execFileSync('cargo', ['update', '--manifest-path', cargoManifestPath, '-p', 'modrex'], {
    stdio: 'inherit',
})
execFileSync(process.execPath, ['scripts/check-version.mjs'], {
    cwd: desktopRoot,
    stdio: 'inherit',
})

// release.yml rejects lightweight tags, so the tag is annotated and carries the release commit's
// message.
const message = `chore(release): ${version}`
execFileSync(
    'git',
    [
        'add',
        '--',
        'package.json',
        'apps/desktop/package.json',
        'apps/desktop/src-tauri/tauri.conf.json',
        'apps/desktop/src-tauri/Cargo.toml',
        'apps/desktop/src-tauri/Cargo.lock',
        'CHANGELOG.md',
    ],
    { cwd: repoRoot, stdio: 'inherit' }
)
execFileSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: 'inherit' })
execFileSync('git', ['tag', '-a', tag, '-m', message], { cwd: repoRoot, stdio: 'inherit' })

console.log(`Created ${tag}. Push it with: git push --follow-tags`)

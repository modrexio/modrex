import { readFileSync, writeFileSync } from 'fs'

// A nightly version stays in the CI workspace, because release.mts accepts only plain X.Y.Z.
const version = process.argv[2]
if (!version) {
    console.error('Usage: bun scripts/stamp-version.mts <version>')
    process.exit(1)
}

function stamp(path: string, pattern: RegExp) {
    const text = readFileSync(path, 'utf8')
    if (!pattern.test(text)) {
        console.error(`stamp-version: no version found in ${path}`)
        process.exit(1)
    }
    writeFileSync(
        path,
        text.replace(pattern, (_, before: string, after: string) => before + version + after)
    )
}

const jsonVersion = /("version": ")[^"]+(")/
stamp('../../package.json', jsonVersion)
stamp('package.json', jsonVersion)
stamp('src-tauri/tauri.conf.json', jsonVersion)
stamp('src-tauri/Cargo.toml', /(^\[package\]\r?\n[\s\S]*?^version = ")[^"]+(")/m)
stamp('src-tauri/Cargo.lock', /(^\[\[package\]\]\r?\nname = "modrex"\r?\nversion = ")[^"]+(")/m)

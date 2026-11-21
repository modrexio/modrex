import { readFileSync } from 'fs'

const MANIFEST_URL = 'https://github.com/modrexio/modrex/releases/download/nightly/latest.json'
const NIGHTLY_VERSION = /^\d+\.\d+\.0-nightly\.\d{8}\.[1-9]\d*$/

/** The nightly after the given one: same base and date add to the counter, anything else starts at 1. */
export function nightlyVersion(stable: string, date: string, live: string | null): string {
    const parts = stable.match(/^(\d+)\.(\d+)\.\d+$/)
    if (!parts) throw new Error(`${stable} is not a plain major.minor.patch version`)
    const prefix = `${parts[1]}.${Number(parts[2]) + 1}.0-nightly.${date}.`
    const counter = live?.startsWith(prefix) ? Number(live.slice(prefix.length)) + 1 : 1
    const version = prefix + counter
    if (!NIGHTLY_VERSION.test(version)) throw new Error(`${version} is not a valid nightly version`)
    return version
}

/** A commit from before a release bump would otherwise be numbered below that release. */
export function assertAboveLatestStable(version: string, latestTag: string) {
    const base = version.split('-')[0]!
    if (Bun.semver.order(base, latestTag.replace(/^v/, '')) !== 1) {
        throw new Error(`${base} is not above the latest stable release ${latestTag}`)
    }
}

// A 404 means no nightly yet. Any other failure stops the run so the counter cannot go back.
async function liveVersion(): Promise<string | null> {
    const response = await fetch(MANIFEST_URL)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`${MANIFEST_URL} answered ${response.status}`)
    return ((await response.json()) as { version: string }).version
}

if (import.meta.main) {
    const latestTag = process.argv[2]
    if (!latestTag) {
        console.error('Usage: bun scripts/nightly-version.mts <latest stable tag>')
        process.exit(1)
    }
    const { version: stable } = JSON.parse(readFileSync('package.json', 'utf8')) as {
        version: string
    }
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const version = nightlyVersion(stable, date, await liveVersion())
    assertAboveLatestStable(version, latestTag)
    console.log(version)
}

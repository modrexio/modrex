// Shields.io endpoint badge serving the README's download count.
//
// Shields' own github/downloads/:user/:repo/total counts every release asset, and for this
// repo that is overwhelmingly the desktop app's own updater polling latest.json (plus the
// electron-era latest.yml and .blockmap sidecars) rather than people installing anything.
// Shields has no wildcard or exclude syntax, and pinning one exact asset name would drop
// Linux and every asset the release naming has used in the past, so the filtering happens
// here instead.
//
// README badge URL:
//   https://img.shields.io/endpoint?url=https://modrex.net/api/downloads

const REPO = 'modrexio/modrex'

// GitHub rejects unauthenticated API requests with no User-Agent.
const GH_API_HEADERS = { 'User-Agent': 'modrex-downloads-worker' }

// One hour, sent both as this response's Cache-Control and as the hint shields honors before
// re-fetching. Shields caches endpoint responses on its own side and GitHub's Camo proxy caches
// the rendered image again, so this is what keeps the GitHub calls below to a trickle.
const CACHE_SECONDS = 3600

// An allowlist, not a blocklist of known metadata suffixes: a new sidecar format added to
// the release workflow would silently inflate the count under a blocklist, whereas a new
// installer format under-counts visibly until it is added here. Matched against the end of
// the asset name, so X.exe.blockmap and X.exe.sig do not count as X.exe.
const INSTALLER_EXTENSIONS = ['.exe', '.msi', '.deb', '.rpm', '.appimage']

// Bounds the work when the release history grows; 500 releases is far beyond any real total.
const MAX_PAGES = 5

interface ReleaseAsset {
    name: string
    download_count: number
}

interface Release {
    assets: ReleaseAsset[]
}

function isInstaller(assetName: string): boolean {
    const lower = assetName.toLowerCase()
    return INSTALLER_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function formatCount(total: number): string {
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
    if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
    return String(total)
}

function badge(body: Record<string, unknown>, cacheSeconds: number): Response {
    return new Response(JSON.stringify({ schemaVersion: 1, label: 'downloads', ...body }), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${cacheSeconds}`,
        },
    })
}

export async function onRequestGet({ env }: { env: { GITHUB_TOKEN?: string } }): Promise<Response> {
    const headers: Record<string, string> = {
        ...GH_API_HEADERS,
        Accept: 'application/vnd.github+json',
    }
    // Unauthenticated callers share 60 requests/hour per IP, and a Workers egress IP is shared
    // with everything else Cloudflare runs. The caching above is what normally keeps this under
    // the limit; the token is the margin when it misses.
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`

    let total = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(
            `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
            { headers }
        )
        if (!res.ok) {
            // Serving a stale-looking number would misreport; say the source is down instead.
            // Cached briefly so a GitHub outage does not turn into a retry storm.
            return badge(
                { message: 'unavailable', color: 'lightgrey', isError: true, cacheSeconds: 300 },
                300
            )
        }
        const releases = (await res.json()) as Release[]
        for (const release of releases) {
            for (const asset of release.assets) {
                if (isInstaller(asset.name)) total += asset.download_count
            }
        }
        if (releases.length < 100) break
    }

    return badge(
        {
            message: formatCount(total),
            color: 'brightgreen',
            cacheSeconds: CACHE_SECONDS,
        },
        CACHE_SECONDS
    )
}

const REPO = 'modrexio/modrex'

export interface Release {
    tag_name: string
    name: string
    body: string
    published_at: string
    html_url: string
    draft: boolean
    prerelease: boolean
    assets: ReleaseAsset[]
}

export interface ReleaseAsset {
    name: string
    browser_download_url: string
    size: number
    download_count: number
}

// Build-time only. The unauthenticated GitHub API allows 60 requests/hour per IP, which shared
// CI build IPs can hit; setting a GITHUB_TOKEN env var raises it to 5000/hour. The token is
// optional so local builds and forks still work without one.
function githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    const token = process.env.GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
}

// The status code alone can't distinguish "rate limited because no token reached
// the build" from "token rejected", so surface GitHub's own explanation and
// whether the env var was visible at all.
async function apiError(res: Response): Promise<Error> {
    const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ')
    const auth = process.env.GITHUB_TOKEN ? 'token present' : 'token absent'
    return new Error(`GitHub API error ${res.status} (${auth}): ${body}`)
}

export async function getLatestRelease(): Promise<Release> {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: githubHeaders(),
    })
    if (!res.ok) throw await apiError(res)
    return (await res.json()) as Release
}

export async function getRecentReleases(count: number): Promise<Release[]> {
    // The list endpoint interleaves drafts and prereleases with published releases,
    // so over-fetch and filter down to the requested count.
    const perPage = count + 10
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${perPage}`, {
        headers: githubHeaders(),
    })
    if (!res.ok) throw await apiError(res)
    const releases = (await res.json()) as Release[]
    return releases.filter((r) => !r.draft && !r.prerelease).slice(0, count)
}

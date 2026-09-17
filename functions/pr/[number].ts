type PagesContext = {
    request: Request
    params: { number: string | string[] }
}

type PullResponse = {
    head?: { sha?: string }
}

type CheckRun = {
    details_url?: string
    output?: { summary?: string | null }
}

type ChecksResponse = {
    check_runs?: CheckRun[]
}

const GITHUB_API = 'https://api.github.com/repos/modrexio/modrex'
const PROJECT_PATH = '/pages/view/modrex-app-preview/'
const BRANCH_URL =
    /Branch Preview URL:[\s\S]*?href=['"](https:\/\/[^'"]+\.modrex-app-preview\.pages\.dev)['"]/

const githubHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'modrex-app-preview',
}

export async function onRequestGet({ request, params }: PagesContext): Promise<Response> {
    const number = params.number
    if (typeof number !== 'string' || !/^[1-9]\d*$/.test(number)) {
        return new Response('Invalid pull request number', { status: 400 })
    }

    try {
        const pullResponse = await fetch(`${GITHUB_API}/pulls/${number}`, {
            headers: githubHeaders,
        })
        if (pullResponse.status === 404) {
            return new Response('Pull request not found', { status: 404 })
        }
        if (!pullResponse.ok) {
            throw new Error(`GitHub pull request request failed with ${pullResponse.status}`)
        }

        const pull = (await pullResponse.json()) as PullResponse
        const sha = pull.head?.sha
        if (!sha) throw new Error('GitHub pull request response has no head commit')

        const checksResponse = await fetch(
            `${GITHUB_API}/commits/${sha}/check-runs?check_name=Cloudflare%20Pages`,
            { headers: githubHeaders }
        )
        if (!checksResponse.ok) {
            throw new Error(`GitHub checks request failed with ${checksResponse.status}`)
        }

        const checks = (await checksResponse.json()) as ChecksResponse
        let branchUrl: string | undefined
        for (const check of checks.check_runs ?? []) {
            if (!check.details_url?.includes(PROJECT_PATH)) continue
            branchUrl = check.output?.summary?.match(BRANCH_URL)?.[1]
            if (branchUrl) break
        }
        if (!branchUrl) {
            return new Response('Pull request preview is not ready', {
                status: 503,
                headers: { 'Retry-After': '30' },
            })
        }

        const target = new URL(branchUrl)
        target.search = new URL(request.url).search
        return new Response(null, {
            status: 302,
            headers: {
                'Cache-Control': 'public, max-age=300',
                Location: target.toString(),
            },
        })
    } catch (error) {
        console.error('Failed to resolve pull request preview', error)
        return new Response('Unable to resolve pull request preview', { status: 502 })
    }
}

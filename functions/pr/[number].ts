type PagesContext = {
    request: Request
    params: { number: string | string[] }
    env?: { GITHUB_TOKEN?: string }
}

type Pull = { head: { sha: string }; updated_at: string }
type Status = { context: string; state: string; target_url?: string | null }

const REPO = 'modrexio/modrex'
const GITHUB_API = `https://api.github.com/repos/${REPO}`
const APP = { project: 'modrex-app-pr', context: 'preview/app', redirect: false }
const HOSTS: Record<string, typeof APP> = {
    'site-preview.modrex.net': {
        project: 'modrex-site-pr',
        context: 'preview/site',
        redirect: true,
    },
}
const ROOT_ASSET_URL = /((?:src|href)=["'])\/(?!\/)/g
// A pull request without a preview status this soon after its last update is still queueing CI.
const BUILD_GRACE_MS = 10 * 60 * 1000

export async function onRequestGet({ request, params, env }: PagesContext): Promise<Response> {
    const number = params.number
    if (typeof number !== 'string' || !/^[1-9]\d*$/.test(number)) {
        return new Response('Invalid pull request number', { status: 400 })
    }

    const url = new URL(request.url)
    const target = HOSTS[url.hostname] ?? APP
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'modrex-preview',
    }
    if (env?.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
    const checks = `https://github.com/${REPO}/pull/${number}/checks`
    const preview = new URL(`https://pr-${number}.${target.project}.pages.dev`)
    preview.search = url.search

    try {
        const pullResponse = await fetch(`${GITHUB_API}/pulls/${number}`, { headers })
        if (pullResponse.status === 404) {
            return page(404, 'Pull request not found', `There is no pull request #${number}.`)
        }
        if (!pullResponse.ok)
            throw new Error(`GitHub pull request request failed with ${pullResponse.status}`)
        const pull = (await pullResponse.json()) as Pull

        const statusResponse = await fetch(`${GITHUB_API}/commits/${pull.head.sha}/status`, {
            headers,
        })
        if (!statusResponse.ok)
            throw new Error(`GitHub status request failed with ${statusResponse.status}`)
        const { statuses } = (await statusResponse.json()) as { statuses: Status[] }
        const status = statuses.find((entry) => entry.context === target.context)
        const logs = status?.target_url || checks

        switch (status?.state) {
            case 'success':
                return target.redirect ? redirect(preview) : proxy(preview)
            case 'pending':
                return page(503, 'Building', 'The preview for the latest commit is being built.', {
                    refresh: 30,
                    links: [['View build', logs]],
                })
            case 'failure':
            case 'error':
                return page(
                    200,
                    'Build failed',
                    'The preview for the latest commit could not be built.',
                    {
                        links: [
                            ['View build', logs],
                            ['Open the last successful build', preview.toString()],
                        ],
                    }
                )
            default:
                if (Date.now() - Date.parse(pull.updated_at) < BUILD_GRACE_MS) {
                    return page(503, 'Building', 'Waiting for the preview build to start.', {
                        refresh: 30,
                        links: [['View checks', checks]],
                    })
                }
                return page(404, 'No preview', 'No preview was built for the latest commit.', {
                    links: [['View checks', checks]],
                })
        }
    } catch (error) {
        console.error('Failed to resolve pull request preview', error)
        return page(
            502,
            'Preview unavailable',
            'The preview could not be resolved. Try again in a moment.'
        )
    }
}

async function proxy(target: URL): Promise<Response> {
    const response = await fetch(target.toString())
    if (!response.ok) throw new Error(`Preview request failed with ${response.status}`)
    const contentType = response.headers.get('Content-Type')
    if (!contentType?.startsWith('text/html')) throw new Error('Preview response is not HTML')
    const html = (await response.text()).replace(ROOT_ASSET_URL, `$1${target.origin}/`)
    return new Response(html, {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': contentType },
    })
}

function redirect(target: URL): Response {
    return new Response(null, {
        status: 302,
        headers: { Location: target.toString(), 'Cache-Control': 'no-store' },
    })
}

function page(
    status: number,
    title: string,
    text: string,
    options: { refresh?: number; links?: [string, string][] } = {}
): Response {
    const escape = (value: string) => value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
    const links = (options.links ?? [])
        .map(([label, href]) => `<a href="${escape(href)}">${escape(label)}</a>`)
        .join(' | ')
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : ''}
<title>${escape(title)} - Modrex preview</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; text-align: center; padding: 1rem; }
main { max-width: 32rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
p { margin: 0 0 1rem; opacity: 0.75; }
a { color: inherit; }
</style>
</head>
<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${links}</main></body>
</html>
`
    const headers: Record<string, string> = {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
    }
    if (options.refresh) headers['Retry-After'] = String(options.refresh)
    return new Response(html, { status, headers })
}

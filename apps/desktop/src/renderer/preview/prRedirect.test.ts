import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from '../../../../../functions/pr/[number]'

const originalFetch = globalThis.fetch

function context(number: string, query = '') {
    return {
        request: new Request(`https://app-preview.modrex.net/pr/${number}${query}`),
        params: { number },
    }
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('/pr/:number', () => {
    it('rejects an invalid pull request number', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>()
        globalThis.fetch = fetch

        const result = await onRequestGet(context('abc'))

        expect(result.status).toBe(400)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('returns not found when the pull request does not exist', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(response({}, 404))

        const result = await onRequestGet(context('999999'))

        expect(result.status).toBe(404)
    })

    it('reports that the preview is not ready', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValueOnce(response({ head: { sha: 'abc123' } }))
            .mockResolvedValueOnce(response({ check_runs: [] }))

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(503)
        expect(result.headers.get('Retry-After')).toBe('30')
    })

    it('serves the app branch preview without replacing the public URL', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response({ head: { sha: 'abc123' } }))
            .mockResolvedValueOnce(
                response({
                    check_runs: [
                        {
                            details_url:
                                'https://dash.cloudflare.com/pages/view/modrex-app-preview/deployments/old',
                            output: { summary: 'Deployment failed' },
                        },
                        {
                            details_url:
                                'https://dash.cloudflare.com/pages/view/modrex-site-monorepo-preview/deployments/one',
                            output: {
                                summary:
                                    "Branch Preview URL: <a href='https://branch.modrex-site-monorepo-preview.pages.dev'>website</a>",
                            },
                        },
                        {
                            details_url:
                                'https://dash.cloudflare.com/pages/view/modrex-app-preview/deployments/two',
                            output: {
                                summary:
                                    "Preview URL: <a href='https://commit.modrex-app-preview.pages.dev'>commit</a><br><strong>Branch Preview URL:</strong> <a href='https://feature.modrex-app-preview.pages.dev'>branch</a>",
                            },
                        },
                    ],
                })
            )
            .mockResolvedValueOnce(
                new Response(
                    '<script type="module" src="/assets/app.js"></script><link href="/assets/app.css">',
                    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                )
            )
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '?library=large&network=offline'))

        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'https://api.github.com/repos/modrexio/modrex/commits/abc123/check-runs?per_page=100',
            expect.anything()
        )
        expect(fetch).toHaveBeenNthCalledWith(
            3,
            'https://feature.modrex-app-preview.pages.dev/?library=large&network=offline'
        )
        expect(result.status).toBe(200)
        expect(result.headers.get('Location')).toBeNull()
        expect(result.headers.get('Cache-Control')).toBe('no-store')
        await expect(result.text()).resolves.toBe(
            '<script type="module" src="https://feature.modrex-app-preview.pages.dev/assets/app.js"></script><link href="https://feature.modrex-app-preview.pages.dev/assets/app.css">'
        )
    })

    it('uses the commit preview when Cloudflare has no branch preview', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValueOnce(response({ head: { sha: 'abc123' } }))
            .mockResolvedValueOnce(
                response({
                    check_runs: [
                        {
                            details_url:
                                'https://dash.cloudflare.com/pages/view/modrex-app-preview/deployments/two',
                            output: {
                                summary:
                                    "<strong>Preview URL:</strong> <a href='https://commit.modrex-app-preview.pages.dev'>commit</a>",
                            },
                        },
                    ],
                })
            )
            .mockResolvedValueOnce(
                new Response('<script src="/assets/app.js"></script>', {
                    headers: { 'Content-Type': 'text/html' },
                })
            )

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(200)
        expect(result.headers.get('Location')).toBeNull()
        await expect(result.text()).resolves.toContain(
            'src="https://commit.modrex-app-preview.pages.dev/assets/app.js"'
        )
    })
})

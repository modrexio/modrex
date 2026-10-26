import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from '../../../../../functions/pr/[number]/[[path]]'

const originalFetch = globalThis.fetch

function context(number: string, query = '', host = 'app-preview.modrex.net', path = '') {
    return {
        request: new Request(`https://${host}/pr/${number}${path}${query}`),
        params: { number, path: path.split('/').filter(Boolean) },
    }
}

const SITE = 'site-preview.modrex.net'

function html(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

function github(
    statuses: { context: string; state: string; target_url?: string }[],
    updatedAt = new Date()
) {
    return vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
            json({ head: { sha: 'abc123' }, updated_at: updatedAt.toISOString() })
        )
        .mockResolvedValueOnce(json({ statuses }))
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
        globalThis.fetch = vi.fn().mockResolvedValue(json({}, 404))

        const result = await onRequestGet(context('999999'))

        expect(result.status).toBe(404)
        await expect(result.text()).resolves.toContain('There is no pull request #999999')
    })

    it('reads the status of the head commit with the configured token', async () => {
        const fetch = github([])
        globalThis.fetch = fetch

        await onRequestGet({ ...context('42'), env: { GITHUB_TOKEN: 'secret' } })

        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'https://api.github.com/repos/modrexio/modrex/commits/abc123/status',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
            })
        )
    })

    it('reports building while the preview status is pending', async () => {
        globalThis.fetch = github([
            {
                context: 'preview/app',
                state: 'pending',
                target_url: 'https://github.com/modrexio/modrex/actions/runs/1',
            },
        ])

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(503)
        expect(result.headers.get('Retry-After')).toBe('30')
        const html = await result.text()
        expect(html).toContain('<meta http-equiv="refresh" content="30">')
        expect(html).toContain('https://github.com/modrexio/modrex/actions/runs/1')
    })

    it('waits for CI when a fresh commit has no preview status yet', async () => {
        globalThis.fetch = github([])

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(503)
        await expect(result.text()).resolves.toContain(
            'https://github.com/modrexio/modrex/pull/42/checks'
        )
    })

    it('reports no preview when an old commit never got a preview status', async () => {
        globalThis.fetch = github([], new Date(Date.now() - 11 * 60 * 1000))

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(404)
        await expect(result.text()).resolves.toContain('No preview was built')
    })

    it('reports a failed build with its logs and the last successful alias', async () => {
        globalThis.fetch = github([
            {
                context: 'preview/app',
                state: 'failure',
                target_url: 'https://github.com/modrexio/modrex/actions/runs/2',
            },
        ])

        const result = await onRequestGet(context('42', '?library=large'))

        expect(result.status).toBe(200)
        const html = await result.text()
        expect(html).toContain('Build failed')
        expect(html).toContain('https://github.com/modrexio/modrex/actions/runs/2')
        expect(html).toContain('https://pr-42.modrex-app-pr.pages.dev/?library=large')
    })

    it('ignores the other preview status', async () => {
        globalThis.fetch = github([{ context: 'preview/site', state: 'success' }])

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(503)
    })

    it('serves the app preview alias without replacing the public URL', async () => {
        const fetch = github([{ context: 'preview/app', state: 'success' }]).mockResolvedValueOnce(
            new Response(
                '<script type="module" src="/assets/app.js"></script><link href="/assets/app.css"><a href="//cdn/x">',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            )
        )
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '?library=large&network=offline'))

        expect(fetch).toHaveBeenNthCalledWith(
            3,
            'https://pr-42.modrex-app-pr.pages.dev/?library=large&network=offline'
        )
        expect(result.status).toBe(200)
        expect(result.headers.get('Location')).toBeNull()
        expect(result.headers.get('Cache-Control')).toBe('no-store')
        await expect(result.text()).resolves.toBe(
            '<script type="module" src="https://pr-42.modrex-app-pr.pages.dev/assets/app.js"></script><link href="https://pr-42.modrex-app-pr.pages.dev/assets/app.css"><a href="//cdn/x">'
        )
    })

    it('adds the trailing slash to the site preview root before asking GitHub', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>()
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '?x=1', SITE))

        expect(fetch).not.toHaveBeenCalled()
        expect(result.status).toBe(302)
        expect(result.headers.get('Location')).toBe('/pr/42/?x=1')
    })

    it('serves site pages under the public URL', async () => {
        const fetch = github([{ context: 'preview/site', state: 'success' }]).mockResolvedValueOnce(
            html('<a href="/pr/42/docs/">Docs</a><img src="/pr/42/_astro/a.webp">')
        )
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '?x=1', SITE, '/docs/games/'))

        expect(fetch).toHaveBeenNthCalledWith(
            3,
            'https://pr-42.modrex-site-pr.pages.dev/docs/games/?x=1',
            { redirect: 'manual' }
        )
        expect(result.status).toBe(200)
        expect(result.headers.get('Location')).toBeNull()
        await expect(result.text()).resolves.toBe(
            '<a href="/pr/42/docs/">Docs</a><img src="/pr/42/_astro/a.webp">'
        )
    })

    it('keeps upstream site redirects under the public URL', async () => {
        globalThis.fetch = github([
            { context: 'preview/site', state: 'success' },
        ]).mockResolvedValueOnce(
            new Response(null, { status: 308, headers: { Location: '/docs/' } })
        )

        const result = await onRequestGet(context('42', '', SITE, '/docs'))

        expect(result.status).toBe(302)
        expect(result.headers.get('Location')).toBe('/pr/42/docs/')
    })

    it('passes the site 404 page through with its status', async () => {
        globalThis.fetch = github([
            { context: 'preview/site', state: 'success' },
        ]).mockResolvedValueOnce(html('<a href="/pr/42/">Home</a>', 404))

        const result = await onRequestGet(context('42', '', SITE, '/missing'))

        expect(result.status).toBe(404)
        await expect(result.text()).resolves.toBe('<a href="/pr/42/">Home</a>')
    })

    it('passes non HTML site responses through unchanged', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(
                new Response('#!/bin/sh', { headers: { 'Content-Type': 'text/x-shellscript' } })
            )

        const result = await onRequestGet(context('42', '', SITE, '/install.sh'))

        expect(result.headers.get('Content-Type')).toBe('text/x-shellscript')
        await expect(result.text()).resolves.toBe('#!/bin/sh')
    })

    it.each(['/index.html', '/docs/index.html'])(
        'checks build status before serving %s',
        async (path) => {
            const fetch = github([{ context: 'preview/site', state: 'pending' }])
            globalThis.fetch = fetch

            const result = await onRequestGet(context('42', '', SITE, path))

            expect(result.status).toBe(503)
            expect(fetch).toHaveBeenCalledTimes(2)
        }
    )

    it('serves inline font CSS and preloads without rewriting the page', async () => {
        const page =
            '<style>@font-face{src:url("/pr/42/_astro/fonts/font.woff2")}</style><link rel="preload" href="/pr/42/_astro/fonts/font.woff2" as="font" crossorigin>'
        globalThis.fetch = github([
            { context: 'preview/site', state: 'success' },
        ]).mockResolvedValueOnce(html(page))

        const result = await onRequestGet(context('42', '', SITE, '/'))

        await expect(result.text()).resolves.toBe(page)
        expect(result.headers.get('X-Robots-Tag')).toBe('noindex')
    })

    it('serves font bytes through the public preview path', async () => {
        const bytes = new Uint8Array([119, 79, 70, 50, 0, 1, 2, 3])
        const fetch = vi
            .fn()
            .mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'font/woff2' } }))
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '', SITE, '/_astro/fonts/font.woff2'))

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledWith(
            'https://pr-42.modrex-site-pr.pages.dev/_astro/fonts/font.woff2',
            { redirect: 'manual' }
        )
        expect(result.headers.get('Content-Type')).toBe('font/woff2')
        expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes)
    })

    it.each(['/pr/42', '/pr/42/docs/'])(
        'does not duplicate the preview base in a redirect to %s',
        async (path) => {
            globalThis.fetch = github([
                { context: 'preview/site', state: 'success' },
            ]).mockResolvedValueOnce(
                new Response(null, {
                    status: 308,
                    headers: { Location: `${path}?q=test#setup` },
                })
            )

            const result = await onRequestGet(context('42', '', SITE, '/docs'))

            expect(result.headers.get('Location')).toBe(`${path}?q=test#setup`)
        }
    )

    it('keeps failed site previews on the public entry point', async () => {
        globalThis.fetch = github([
            {
                context: 'preview/site',
                state: 'failure',
                target_url: 'https://github.com/modrexio/modrex/actions/runs/2',
            },
        ])

        const result = await onRequestGet(context('42', '', SITE, '/'))
        const page = await result.text()

        expect(page).toContain('Build failed')
        expect(page).toContain('https://github.com/modrexio/modrex/actions/runs/2')
        expect(page).not.toContain('pages.dev')
    })

    it('rejects paths below the app preview', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>()
        globalThis.fetch = fetch

        const result = await onRequestGet(context('42', '', 'app-preview.modrex.net', '/x'))

        expect(fetch).not.toHaveBeenCalled()
        expect(result.status).toBe(404)
    })

    it('reports the preview as unavailable when GitHub fails', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(json({}, 500))

        const result = await onRequestGet(context('42'))

        expect(result.status).toBe(502)
    })
})

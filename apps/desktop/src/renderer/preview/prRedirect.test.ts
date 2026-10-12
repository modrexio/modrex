import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, rewriteSitePage } from '../../../../../functions/pr/[number]/[[path]]'

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
            html('<a href="/docs/">Docs</a><img src="/_astro/a.webp">')
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
            '<a href="/pr/42/docs/">Docs</a><img src="https://pr-42.modrex-site-pr.pages.dev/_astro/a.webp">'
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
        ]).mockResolvedValueOnce(html('<a href="/">Home</a>', 404))

        const result = await onRequestGet(context('42', '', SITE, '/missing'))

        expect(result.status).toBe(404)
        await expect(result.text()).resolves.toBe('<a href="/pr/42/">Home</a>')
    })

    it('passes non HTML site responses through unchanged', async () => {
        globalThis.fetch = github([
            { context: 'preview/site', state: 'success' },
        ]).mockResolvedValueOnce(
            new Response('#!/bin/sh', { headers: { 'Content-Type': 'text/x-shellscript' } })
        )

        const result = await onRequestGet(context('42', '', SITE, '/install.sh'))

        expect(result.headers.get('Content-Type')).toBe('text/x-shellscript')
        await expect(result.text()).resolves.toBe('#!/bin/sh')
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

describe('rewriteSitePage', () => {
    const origin = 'https://pr-42.modrex-site-pr.pages.dev'

    it('keeps links on the public URL and loads assets from the alias', () => {
        expect(
            rewriteSitePage(
                '<link rel="stylesheet" href="/_astro/a.css"><script type="module" src="/_astro/b.js"></script><a class="x" href="/docs/">',
                origin,
                '/pr/42'
            )
        ).toBe(
            `<link rel="stylesheet" href="${origin}/_astro/a.css"><script type="module" src="${origin}/_astro/b.js"></script><a class="x" href="/pr/42/docs/">`
        )
    })

    it('rewrites every candidate in a srcset', () => {
        expect(
            rewriteSitePage(
                '<img srcset="/_astro/a.webp 640w, /_astro/b.webp 1280w">',
                origin,
                '/pr/42'
            )
        ).toBe(`<img srcset="${origin}/_astro/a.webp 640w, ${origin}/_astro/b.webp 1280w">`)
    })

    it('leaves absolute, protocol relative and fragment URLs alone', () => {
        const page =
            '<a href="https://modrex.net/"><a href="//cdn.example/x"><a href="#top"><img src="data:image/png;base64,AA">'
        expect(rewriteSitePage(page, origin, '/pr/42')).toBe(page)
    })
})

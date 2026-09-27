import type { AstroIntegration } from 'astro'
import * as pagefind from 'pagefind'

// Pagefind indexes the HTML files that astro build writes, and astro dev writes
// none, so Starlight turns search off in dev. This builds the same index from the
// docs pages the dev server renders and serves it where the search dialog loads
// it from. The index is built on the first search and rebuilt after any edit.
export default function devSearch(): AstroIntegration {
    return {
        name: 'modrex-dev-search',
        hooks: {
            'astro:server:setup': ({ server }) => {
                let index: Promise<Map<string, Uint8Array>> | null = null
                server.watcher.on('change', () => {
                    index = null
                })
                server.httpServer?.once('close', () => pagefind.close())

                server.middlewares.use('/pagefind', async (req, res, next) => {
                    index ??= buildIndex(`http://${req.headers.host}`)
                    try {
                        const file = (await index).get(req.url!.split('?')[0].slice(1))
                        if (!file) return next()
                        res.setHeader('Content-Type', contentType(req.url!))
                        res.end(file)
                    } catch (error) {
                        index = null
                        next(error)
                    }
                })
            },
        },
    }
}

async function buildIndex(origin: string) {
    const { index, errors } = await pagefind.createIndex()
    if (!index) throw new Error(`Pagefind could not start: ${errors.join(', ')}`)

    // The sidebar links every docs page from every other, so following /docs/
    // links from the landing page reaches all of them.
    const queue = ['/docs/']
    const seen = new Set(queue)
    for (const path of queue) {
        const response = await fetch(origin + path)
        if (!response.ok) throw new Error(`Indexing ${path} failed with ${response.status}`)
        const html = await response.text()
        const added = await index.addHTMLFile({ url: path, content: html })
        if (added.errors.length > 0) throw new Error(`Indexing ${path}: ${added.errors.join(', ')}`)

        // Docs links appear both with and without a trailing slash. Counting them
        // once keeps a page from being indexed, and listed in results, twice.
        for (const [, href] of html.matchAll(/href="(\/docs\/[^"#?]*)"/g)) {
            const page = href.endsWith('/') ? href : `${href}/`
            if (seen.has(page)) continue
            seen.add(page)
            queue.push(page)
        }
    }

    const { files, errors: fileErrors } = await index.getFiles()
    if (fileErrors.length > 0) throw new Error(`Pagefind output: ${fileErrors.join(', ')}`)
    await index.deleteIndex()
    return new Map(files.map((file) => [file.path, file.content]))
}

function contentType(url: string) {
    if (url.endsWith('.js')) return 'text/javascript'
    if (url.endsWith('.css')) return 'text/css'
    if (url.endsWith('.json')) return 'application/json'
    if (url.endsWith('.wasm')) return 'application/wasm'
    return 'application/octet-stream'
}

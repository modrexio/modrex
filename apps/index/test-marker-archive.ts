// Marker extraction against the shapes real mod hosts serve. ModWorkshop's own CDN always
// declares a length and honours byte ranges, but a mod whose download is an off-site link can
// point anywhere, and the host it points at decides how the archive arrives.

import AdmZip from 'adm-zip'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

// The fixtures below are served from loopback, which the address check refuses by design, so
// the main pass lifts that one range. Loopback must still be refused when it is not lifted,
// which only a process without the variable can assert: --guarded is that second pass, run at
// the end of the first.
const guardedPass = process.argv.includes('--guarded')
if (!guardedPass) process.env.MODREX_INDEX_ALLOW_LOOPBACK_FETCH = '1'

const {
    assertFetchableUrl,
    extractMarkerEntry,
    isTransientStatus,
    TransientFetchError,
    UnusableDownloadError,
} = await import('./postgres/marker-archive.js')

const loopbackUrls = [
    'http://localhost:8080/mod.zip',
    'http://127.0.0.1/mod.zip',
    'http://127.16.3.4/mod.zip',
    'http://[::1]/mod.zip',
    'http://[::ffff:127.0.0.1]/mod.zip',
]

if (guardedPass) {
    for (const blocked of loopbackUrls) {
        await assert.rejects(
            assertFetchableUrl(blocked),
            /blocked host/,
            `${blocked} must be refused`
        )
        assert.equal(await extractMarkerEntry(blocked, null), null, `${blocked} indexes nothing`)
    }

    // The test flag narrows the loopback exemption; it must not widen the scheme policy.
    await assert.rejects(
        assertFetchableUrl('http://172.32.0.1/mod.zip'),
        /insecure scheme/,
        'plain http: to a reachable, non-blocked address must be refused without the test flag'
    )

    console.log('marker archive loopback guard test passed')
    process.exit(0)
}

const markerContent = Buffer.from('{\n\t"name" : "Link Hosted Mod",\n\t"version" : "1.2"\n}\n')
const expectedSha256 = createHash('sha256').update(markerContent).digest('hex')

const zip = new AdmZip()
zip.addFile('Link Hosted Mod/', Buffer.alloc(0))
zip.addFile('Link Hosted Mod/lua/init.lua', Buffer.from('-- lua\n'))
zip.addFile('Link Hosted Mod/mod.txt', markerContent)
const archive = zip.toBuffer()

const overCapBytes = 51 * 1024 * 1024

// A marker entry that is small to download and huge to inflate. Deflate reaches ~1000x on
// zeros, so this is well under a megabyte on the wire.
const bomb = new AdmZip()
bomb.addFile('Bomb Mod/mod.txt', Buffer.alloc(60 * 1024 * 1024))
const bombArchive = bomb.toBuffer()

const server = createServer((request, response) => {
    const path = new URL(request.url ?? '', 'http://localhost').pathname
    const range = request.headers.range

    if (path === '/ranged.zip') {
        if (request.method === 'HEAD') {
            response.writeHead(200, { 'content-length': String(archive.length) }).end()
            return
        }
        const match = range?.match(/^bytes=(\d+)-(\d+)$/)
        if (!match) {
            response.writeHead(200, { 'content-length': String(archive.length) }).end(archive)
            return
        }
        const slice = archive.subarray(Number(match[1]), Number(match[2]) + 1)
        response
            .writeHead(206, {
                'content-length': String(slice.length),
                'content-range': `bytes ${match[1]}-${match[2]}/${archive.length}`,
            })
            .end(slice)
        return
    }

    // GitHub's source-archive endpoint builds the zip per request: no length, no ranges.
    if (path === '/generated.zip') {
        response.writeHead(200, { 'content-type': 'application/zip' }).end(archive)
        return
    }

    if (path === '/generated.html') {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html>not a download</html>')
        return
    }

    if (path === '/head-blocked-oversized.zip') {
        if (request.method === 'HEAD') {
            response.writeHead(405).end()
            return
        }
        response.writeHead(200, { 'content-length': String(overCapBytes) }).end(archive)
        return
    }

    if (path === '/streamed-oversized.zip') {
        response.writeHead(200)
        for (let sent = 0; sent < overCapBytes; sent += 1024 * 1024) {
            response.write(Buffer.alloc(1024 * 1024))
        }
        response.end()
        return
    }

    if (path === '/bomb.zip') {
        if (request.method === 'HEAD') {
            response.writeHead(200, { 'content-length': String(bombArchive.length) }).end()
            return
        }
        const match = range?.match(/^bytes=(\d+)-(\d+)$/)
        const slice = match
            ? bombArchive.subarray(Number(match[1]), Number(match[2]) + 1)
            : bombArchive
        response.writeHead(match ? 206 : 200).end(slice)
        return
    }

    // A public URL that hands the fetcher an internal address.
    if (path === '/redirect-to-metadata.zip') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
        return
    }

    if (path === '/redirect-loop.zip') {
        response.writeHead(302, { location: '/redirect-loop.zip' }).end()
        return
    }

    // Redirects to a reachable, non-blocked address, but over http: instead of https:.
    if (path === '/redirect-to-http.zip') {
        response.writeHead(302, { location: 'http://172.32.0.1/mod.zip' }).end()
        return
    }

    // Answers that settle the listing: the host has told us there is nothing to read here.
    if (path === '/gone.zip') {
        response.writeHead(410).end()
        return
    }
    if (path === '/unsatisfiable.zip') {
        if (request.method === 'HEAD') {
            response.writeHead(200, { 'content-length': String(archive.length) }).end()
            return
        }
        response.writeHead(416).end()
        return
    }

    // Answers that settle nothing: something in front of the host is refusing, not the file.
    if (path === '/forbidden.zip') {
        response.writeHead(403, { 'content-type': 'text/html' }).end('<html>blocked</html>')
        return
    }
    if (path === '/unavailable.zip') {
        response.writeHead(503).end()
        return
    }
    if (path === '/throttled.zip') {
        response.writeHead(429).end()
        return
    }
    // GitLab's shape: an archive URL that serves fine once the address stops asking so often.
    if (path === '/not-acceptable.zip') {
        response.writeHead(406, { 'content-type': 'text/html' }).end()
        return
    }
    if (path === '/reset.zip') {
        request.socket.destroy()
        return
    }

    // mega.nz's shape: HEAD is never answered at all, and the GET that follows serves the
    // host's download page. The listing is settled by the page, not by the unanswered probe.
    if (path === '/head-hangs-then-document.zip') {
        if (request.method === 'HEAD') return
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html>download page</html>')
        return
    }

    response.writeHead(404).end()
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address() as AddressInfo
const url = (path: string) => `http://127.0.0.1:${port}${path}`

try {
    assert.deepEqual(
        await extractMarkerEntry(url('/ranged.zip'), null),
        { sha256: expectedSha256, entryName: 'Link Hosted Mod/mod.txt' },
        'a host that declares a length and honours ranges reads the marker through Range'
    )

    assert.deepEqual(
        await extractMarkerEntry(url('/ranged.zip'), archive.length),
        { sha256: expectedSha256, entryName: 'Link Hosted Mod/mod.txt' },
        'a known size skips the HEAD request and still reads the marker'
    )

    assert.deepEqual(
        await extractMarkerEntry(url('/generated.zip'), null),
        { sha256: expectedSha256, entryName: 'Link Hosted Mod/mod.txt' },
        'an archive generated per request yields the same marker hash as a ranged one'
    )

    assert.equal(
        await extractMarkerEntry(url('/generated.html'), null),
        null,
        'a link that points at a web page instead of an archive indexes nothing'
    )

    assert.equal(
        await extractMarkerEntry(url('/head-blocked-oversized.zip'), null),
        null,
        'a declared length past the cap is rejected before the body is read'
    )

    assert.equal(
        await extractMarkerEntry(url('/streamed-oversized.zip'), null),
        null,
        'a body that passes the cap mid-stream is abandoned'
    )

    assert.equal(
        await extractMarkerEntry(url('/missing.zip'), null),
        null,
        'a dead link indexes nothing'
    )

    assert.equal(
        await extractMarkerEntry(url('/bomb.zip'), null),
        null,
        'a marker entry that inflates past the cap indexes nothing instead of exhausting memory'
    )

    // A link URL comes off a mod page, so these are the addresses it must never reach.
    for (const blocked of [
        'http://10.0.0.5/mod.zip',
        'http://172.16.4.5/mod.zip',
        'http://172.31.255.1/mod.zip',
        'http://192.168.1.1/mod.zip',
        'http://169.254.169.254/latest/meta-data/',
        'http://[fd00::1]/mod.zip',
        'http://[fe80::1]/mod.zip',
        'http://0.0.0.0/mod.zip',
        'file:///etc/passwd',
        'ftp://example.com/mod.zip',
    ]) {
        await assert.rejects(
            assertFetchableUrl(blocked),
            /blocked host|unsupported scheme|resolves to/,
            `${blocked} must be refused`
        )
        assert.equal(
            await extractMarkerEntry(blocked, null),
            null,
            `${blocked} must index nothing rather than fail the run`
        )
    }

    // Addresses outside those ranges stay reachable, or the check would break real hosts.
    for (const allowed of ['https://github.com/x/y/archive/main.zip', 'https://172.32.0.1/m.zip']) {
        await assert.doesNotReject(assertFetchableUrl(allowed), `${allowed} must stay reachable`)
    }

    await assert.rejects(
        assertFetchableUrl('http://172.32.0.1/m.zip'),
        /insecure scheme/,
        'a reachable, non-blocked address must still be refused over http:'
    )

    assert.equal(
        await extractMarkerEntry(url('/redirect-to-http.zip'), null),
        null,
        'a redirect to a plain http: target is stopped at the hop instead of being followed'
    )

    assert.equal(
        await extractMarkerEntry(url('/redirect-to-metadata.zip'), null),
        null,
        'a public URL redirecting to an internal address is stopped at the hop'
    )

    assert.equal(
        await extractMarkerEntry(url('/redirect-loop.zip'), null),
        null,
        'a redirect loop ends instead of spinning, and settles the listing'
    )

    // Whether a listing can be recorded as checked turns entirely on this split, so it is
    // asserted on the status table itself rather than only through the hosts that motivated it.
    for (const settled of [400, 401, 404, 405, 410, 415, 416, 451]) {
        assert.equal(isTransientStatus(settled), false, `${settled} is an answer`)
    }
    // 403 belongs with the throttles, not with the refusals: it is what an anti-abuse layer in
    // front of a host says, and recording an empty check on one would lose the mod for good.
    for (const retryable of [403, 406, 408, 425, 429, 500, 502, 503, 504]) {
        assert.equal(isTransientStatus(retryable), true, `${retryable} is not an answer yet`)
    }

    for (const settled of ['/gone.zip', '/unsatisfiable.zip']) {
        assert.equal(
            await extractMarkerEntry(url(settled), null),
            null,
            `${settled} indexes nothing rather than staying pending forever`
        )
    }

    for (const retryable of [
        '/unavailable.zip',
        '/throttled.zip',
        '/not-acceptable.zip',
        '/forbidden.zip',
        '/reset.zip',
    ]) {
        await assert.rejects(
            extractMarkerEntry(url(retryable), null),
            TransientFetchError,
            `${retryable} stays retryable instead of being recorded as empty`
        )
    }

    // A name that does not resolve reads as permanent and is not: domains lapse and come back,
    // and a resolver on the runner can fail on its own. Nothing under .invalid ever resolves.
    await assert.rejects(
        extractMarkerEntry('https://mod-host.invalid/mod.zip', null),
        TransientFetchError,
        'a host that does not resolve stays retryable'
    )

    const startedAt = Date.now()
    assert.equal(
        await extractMarkerEntry(url('/head-hangs-then-document.zip'), null),
        null,
        'a host that never answers HEAD is settled by the page it serves over GET'
    )
    assert.ok(
        Date.now() - startedAt < 60_000,
        'an unanswered HEAD gives up long before the download timeout it stands in for'
    )

    // The batch as a whole: one link that cannot be read must leave the others exactly as they
    // would have been, which is the property the export step depends on.
    const batch = [
        '/ranged.zip',
        '/gone.zip',
        '/unavailable.zip',
        '/generated.zip',
        '/generated.html',
        '/reset.zip',
    ]
    const outcomes = await Promise.all(
        batch.map(async (path) => {
            try {
                return (await extractMarkerEntry(url(path), null)) ? 'indexed' : 'nothing-to-index'
            } catch (error) {
                if (error instanceof TransientFetchError) return 'deferred'
                if (error instanceof UnusableDownloadError) return 'nothing-to-index'
                throw error
            }
        })
    )
    assert.deepEqual(
        outcomes,
        ['indexed', 'nothing-to-index', 'deferred', 'indexed', 'nothing-to-index', 'deferred'],
        'a mixed batch keeps every successful extraction and defers only what it must'
    )

    console.log('marker archive extraction test passed')
} finally {
    server.close()
}

const guardedEnv = { ...process.env }
delete guardedEnv.MODREX_INDEX_ALLOW_LOOPBACK_FETCH
execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--guarded'], {
    stdio: 'inherit',
    env: guardedEnv,
})

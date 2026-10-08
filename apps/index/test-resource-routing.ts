import AdmZip from 'adm-zip'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GAMES, type GameSpec } from '@modrex/games'
import type { DownloadableInput } from './postgres/downloadable-state.js'

process.env.MODREX_INDEX_ALLOW_LOOPBACK_FETCH = '1'
const { extractEntries, extractionPolicy, isLooseResource } =
    await import('./postgres/content-extraction.js')
const { MARKER_EXTRACTION_POLICY, UNREAL_EXTRACTION_POLICY } =
    await import('./postgres/downloadable-state.js')

const thirdGame: GameSpec = { ...GAMES.pd3, name: 'Another game', storageKey: 'another-game' }
const movieOnly: GameSpec = { ...thirdGame, configPresets: undefined }
const configOnly: GameSpec = { ...thirdGame, movieReplacement: undefined }
const markerWithResources: GameSpec = {
    ...GAMES.pd2,
    movieReplacement: thirdGame.movieReplacement,
    configPresets: thirdGame.configPresets,
}
const markerWithoutResources: GameSpec = {
    ...markerWithResources,
    movieReplacement: undefined,
    configPresets: undefined,
}

assert.equal(extractionPolicy(thirdGame), UNREAL_EXTRACTION_POLICY)
assert.equal(extractionPolicy(markerWithoutResources), MARKER_EXTRACTION_POLICY)
assert.notEqual(extractionPolicy(configOnly), extractionPolicy(movieOnly))
assert.notEqual(extractionPolicy(markerWithResources), MARKER_EXTRACTION_POLICY)

const movie = Buffer.from('movie bytes')
const config = Buffer.from('[Settings]\nSize=2\n')
const marker = Buffer.from('{"name":"A mod"}')
const zip = new AdmZip()
zip.addFile('mod.txt', marker)
zip.addFile('Payload.pak', Buffer.from('package bytes'))
zip.addFile('Intro.bk2', movie)
zip.addFile('Engine.ini', config)
const archive = zip.toBuffer()
let fullDownloads = 0
const server = createServer((request, response) => {
    const payload =
        request.url === '/Intro.bk2' ? movie : request.url === '/Engine.ini' ? config : archive
    response.setHeader('Content-Length', payload.length)
    if (request.method === 'HEAD') return response.end()
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (range) {
        const start = Number(range[1])
        const end = Math.min(Number(range[2]), payload.length - 1)
        const selected = payload.subarray(start, end + 1)
        response.writeHead(206, {
            'Content-Length': selected.length,
            'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        })
        return response.end(selected)
    }
    fullDownloads++
    response.end(payload)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
function input(
    game: GameSpec,
    filename: string,
    kind: 'file' | 'link' = 'file'
): DownloadableInput {
    return {
        policy: extractionPolicy(game),
        kind,
        remoteId: 1,
        url: `${baseUrl}/${filename}`,
        version: '1',
        objectKey: filename,
        size: null,
        mediaType: filename.split('.').at(-1)!,
        sourceFilename: filename,
    }
}

try {
    assert.equal(isLooseResource(thirdGame, input(thirdGame, 'Intro.bk2')), true)
    assert.equal(isLooseResource(movieOnly, input(movieOnly, 'Engine.ini')), false)
    assert.equal(isLooseResource(configOnly, input(configOnly, 'Intro.bk2')), false)
    assert.equal(
        isLooseResource(markerWithoutResources, input(markerWithoutResources, 'Intro.bk2')),
        false
    )
    const all = await extractEntries(thirdGame, input(thirdGame, 'mixed.zip'))
    assert.deepEqual(all.map((entry) => entry.entryName).sort(), [
        'Engine.ini',
        'Intro.bk2',
        'Payload.pak',
    ])
    const movies = await extractEntries(movieOnly, input(movieOnly, 'mixed.zip'))
    assert.deepEqual(
        movies.filter((entry) => entry.resource).map((entry) => entry.resource?.kind),
        ['movie']
    )
    const configs = await extractEntries(configOnly, input(configOnly, 'mixed.zip'))
    assert.deepEqual(
        configs.filter((entry) => entry.resource).map((entry) => entry.resource?.kind),
        ['config']
    )
    const mixed = await extractEntries(markerWithResources, input(markerWithResources, 'mixed.zip'))
    assert.deepEqual(mixed.map((entry) => entry.entryName).sort(), [
        'Engine.ini',
        'Intro.bk2',
        'mod.txt',
    ])
    const beforeLinks = fullDownloads
    for (const game of [markerWithResources, markerWithoutResources]) {
        const malformedLink = input(game, 'a%zz.zip', 'link')
        assert.equal(isLooseResource(game, malformedLink), false)
        assert.deepEqual(
            (await extractEntries(game, malformedLink)).map((entry) => entry.entryName),
            ['mod.txt'],
            'author URLs need not have decodable filenames for bounded marker extraction'
        )
    }
    const link = await extractEntries(
        markerWithResources,
        input(markerWithResources, 'mixed.zip', 'link')
    )
    assert.deepEqual(
        link.map((entry) => entry.entryName),
        ['mod.txt']
    )
    assert.equal(
        fullDownloads,
        beforeLinks,
        'resource support keeps external links on bounded marker extraction'
    )
    const loose = await extractEntries(markerWithResources, input(markerWithResources, 'Intro.bk2'))
    assert.deepEqual(
        loose.map((entry) => entry.resource?.kind),
        ['movie']
    )
    assert.equal(
        loose.some((entry) => !entry.resource),
        false,
        'a loose movie never becomes an ordinary marker'
    )
} finally {
    server.close()
}
console.log('resource capability routing test passed')

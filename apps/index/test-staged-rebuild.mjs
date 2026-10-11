import Database from 'better-sqlite3'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { GAME_IDS, GAMES } from '@modrex/games'

const repoDir = fileURLToPath(new URL('.', import.meta.url))
const outputDir = await mkdtemp(join(tmpdir(), 'modrex-index-stage-'))

const modworkshopGames = GAME_IDS.filter((game) => GAMES[game].workshopId !== undefined)
const gameIds = new Map(modworkshopGames.map((game) => [String(GAMES[game].workshopId), game]))
let transientFailures = 0
let listingRequests = 0

const server = createServer(async (request, response) => {
    listingRequests++
    const match = new URL(request.url, 'http://localhost').pathname.match(/^\/games\/(\d+)\/mods$/)
    const game = match ? gameIds.get(match[1]) : null
    if (!game) {
        response.writeHead(404).end()
        return
    }
    if (game === 'pd3' && transientFailures < 2) {
        transientFailures++
        response.writeHead(520).end()
        return
    }

    // The listing must outlast the stage budget to exercise checkpointing.
    if (game === 'pd2') await delay(50)

    const now = new Date().toISOString()
    response.setHeader('content-type', 'application/json')
    response.end(
        JSON.stringify({
            data: [
                {
                    id: Number(match[1]) * 10,
                    name: `${game} test mod`,
                    version: '1.0',
                    has_download: false,
                    bumped_at: now,
                    updated_at: now,
                    download_id: null,
                    download_type: null,
                },
            ],
            meta: { current_page: 1, last_page: 1 },
        })
    )
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const env = {
    ...process.env,
    MODWORKSHOP_API_BASE: `http://127.0.0.1:${address.port}`,
    MODREX_INDEX_OUTPUT_DIR: outputDir,
}

function run(args, expectedCode = 0) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['build-index.ts', ...args], {
            cwd: repoDir,
            env,
            stdio: 'pipe',
        })
        let output = ''
        child.stdout.on('data', (chunk) => (output += chunk))
        child.stderr.on('data', (chunk) => (output += chunk))
        child.on('error', reject)
        child.on('exit', (code) => {
            if (code !== expectedCode) {
                reject(new Error(`Expected exit ${expectedCode}, got ${code}:\n${output}`))
            } else {
                resolve(output)
            }
        })
    })
}

try {
    for (const game of GAME_IDS.filter((game) => GAMES[game].workshopId === undefined)) {
        const stagedOutput = await run(['--staged-rebuild', `--game=${game}`], 1)
        assert.match(stagedOutput, /--staged-rebuild requires --game=/)
        const backfillOutput = await run(['--backfill', `--game=${game}`], 1)
        assert.match(backfillOutput, /--game must be one of/)
    }
    assert.equal(listingRequests, 0, 'source-less games must fail before API requests')
    assert.deepEqual(
        await readdir(outputDir),
        [],
        'source-less games must fail before database writes'
    )

    await run(['--staged-rebuild', '--game=raid', '--finalize-rebuild'], 1)
    await rm(outputDir, { recursive: true, force: true })
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir))

    const pd3Output = await run(['--staged-rebuild', '--game=pd3'])
    assert.match(pd3Output, /\[520\].*retrying/)
    const db = new Database(join(outputDir, 'index.db'), { readonly: true })
    const startedAt = db
        .prepare("SELECT value FROM metadata WHERE key = 'staged_rebuild_started_at'")
        .pluck()
        .get()
    assert.ok(startedAt)
    assert.deepEqual(
        JSON.parse(
            db
                .prepare("SELECT value FROM metadata WHERE key = 'staged_rebuild_completed_games'")
                .pluck()
                .get()
        ),
        ['pd3']
    )
    db.close()

    await run(['--staged-rebuild', '--game=pd2', '--max-runtime-minutes=0.0001'], 3)
    await run(['--staged-rebuild', '--game=pd2'])
    for (const game of modworkshopGames.filter((game) => !['pd3', 'pd2', 'raid'].includes(game))) {
        await run(['--staged-rebuild', `--game=${game}`])
    }
    await run(['--staged-rebuild', '--game=raid', '--finalize-rebuild'])

    const finalDb = new Database(join(outputDir, 'index.db'), { readonly: true })
    try {
        assert.equal(finalDb.pragma('integrity_check', { simple: true }), 'ok')
        assert.deepEqual(
            finalDb.prepare('SELECT slug, name FROM games ORDER BY slug').all(),
            modworkshopGames.toSorted().map((slug) => ({ slug, name: GAMES[slug].name }))
        )
        assert.deepEqual(
            finalDb
                .prepare(
                    'SELECT DISTINCT games.slug, sources.name, sources.game_ref FROM sources JOIN games ON games.id = sources.game_id ORDER BY games.slug'
                )
                .all(),
            modworkshopGames.toSorted().map((slug) => ({
                slug,
                name: 'modworkshop',
                game_ref: String(GAMES[slug].workshopId),
            }))
        )
        assert.equal(
            finalDb.prepare("SELECT value FROM metadata WHERE key = 'last_run_at'").pluck().get(),
            startedAt
        )
        assert.equal(
            finalDb
                .prepare("SELECT COUNT(*) FROM metadata WHERE key LIKE 'staged_rebuild_%'")
                .pluck()
                .get(),
            0
        )
    } finally {
        finalDb.close()
    }

    const stats = JSON.parse(await readFile(join(outputDir, 'index-stats.json'), 'utf8'))
    assert.equal(stats.lastRunAt, startedAt)

    await run(['--game=pd3'], 1)
    const scopedBackfillOutput = await run(['--backfill', '--game=pd3'], 2)
    assert.match(scopedBackfillOutput, /Fetching PD3 mod list/)
    assert.doesNotMatch(scopedBackfillOutput, /Fetching PD2 mod list/)
    console.log('staged rebuild checkpoint/resume test passed')
} finally {
    server.close()
    await rm(outputDir, { recursive: true, force: true })
}

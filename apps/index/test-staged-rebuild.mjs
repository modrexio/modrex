import Database from 'better-sqlite3'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoDir = fileURLToPath(new URL('.', import.meta.url))
const outputDir = await mkdtemp(join(tmpdir(), 'modrex-index-stage-'))

const gameIds = new Map([
    ['853', 'pd3'],
    ['1', 'pd2'],
    ['2', 'pdth'],
    ['857', 'cb'],
    ['543', 'raid'],
])
let transientFailures = 0

const server = createServer(async (request, response) => {
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
    await run(['--staged-rebuild', '--game=pdth'])
    await run(['--staged-rebuild', '--game=cb'])
    await run(['--staged-rebuild', '--game=raid', '--finalize-rebuild'])

    const finalDb = new Database(join(outputDir, 'index.db'), { readonly: true })
    assert.equal(finalDb.pragma('integrity_check', { simple: true }), 'ok')
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
    finalDb.close()

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

// The content processor exits zero when author-supplied links cannot be read, because one
// unreachable mod page must not stop the run from exporting and publishing everything else.
// That only holds if the failures which are the pipeline's own still end the run, so the exit
// code is asserted here rather than left to the next incident.

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const processor = fileURLToPath(new URL('postgres/process-content.ts', import.meta.url))

async function exitCode(env: Record<string, string | undefined>, args: string[]): Promise<number> {
    const child = spawn(process.execPath, [processor, ...args], {
        env: { ...process.env, ...env },
        stdio: 'ignore',
    })
    return new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (code) => resolve(code ?? 1))
    })
}

// An address nothing answers on, so the first query fails the way an outage does. The listing
// query runs before any mod page is contacted, so this needs no network of its own.
const unreachableDatabase = 'postgres://index:index@127.0.0.1:1/index'

assert.notEqual(
    await exitCode({ INDEX_DATABASE_URL: undefined }, ['--game=pd2', '--limit=1']),
    0,
    'a missing database URL fails the run'
)

assert.notEqual(
    await exitCode({ INDEX_DATABASE_URL: unreachableDatabase }, ['--game=pd2', '--limit=1']),
    0,
    'a database that cannot be reached fails the run'
)

assert.notEqual(
    await exitCode({ INDEX_DATABASE_URL: unreachableDatabase }, ['--game=nope', '--limit=1']),
    0,
    'an unknown game fails the run'
)

console.log('process content failure test passed')

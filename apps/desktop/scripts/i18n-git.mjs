import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The whole history engine reaches Git through this module. Everything above it works on
// plain snapshots, so transition analysis stays pure and tests can count how often blobs
// are actually read.

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export class GitCommandError extends Error {
    constructor(args, cause) {
        const stderr = cause.stderr?.toString('utf8').trim()
        super(`git ${args.join(' ')} failed: ${stderr || cause.message}`)
        this.name = 'GitCommandError'
        this.args = args
        this.status = cause.status
        this.cause = cause
    }
}

export class GitBlobDecodeError extends Error {
    constructor(oid, cause) {
        super(`Git blob ${oid} is not valid UTF-8`, { cause })
        this.name = 'GitBlobDecodeError'
        this.oid = oid
    }
}

export function createGitRunner(cwd) {
    return function run(args, { input, expectedExitCodes = [] } = {}) {
        try {
            const stdout = execFileSync('git', args, {
                cwd,
                env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
                input,
                maxBuffer: MAX_GIT_OUTPUT_BYTES,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            return { status: 0, stdout, stderr: Buffer.alloc(0) }
        } catch (error) {
            if (expectedExitCodes.includes(error.status)) {
                return {
                    status: error.status,
                    stdout: error.stdout ?? Buffer.alloc(0),
                    stderr: error.stderr ?? Buffer.alloc(0),
                }
            }
            throw new GitCommandError(args, error)
        }
    }
}

function splitNulTerminated(buffer) {
    return buffer.toString('utf8').split('\0').filter(Boolean)
}

// git cat-file --batch answers each requested id with a header line followed by exactly
// <size> bytes and one newline. Sizes are byte counts, so the payload has to be sliced off
// the raw buffer rather than off a decoded string.
function parseBatchOutput(buffer, counters) {
    const blobs = new Map()
    let offset = 0
    while (offset < buffer.length) {
        const newline = buffer.indexOf(0x0a, offset)
        if (newline === -1) throw new Error('git cat-file --batch returned a truncated header')
        const header = buffer.toString('utf8', offset, newline)
        const [id, type, size] = header.split(' ')
        if (type === undefined || size === undefined) {
            throw new Error(`git cat-file --batch could not provide ${header}`)
        }
        if (type !== 'blob') throw new Error(`git cat-file --batch returned ${type} for ${id}`)
        if (!/^\d+$/u.test(size)) {
            throw new Error(`git cat-file --batch returned an invalid size for ${id}`)
        }
        const start = newline + 1
        const end = start + Number(size)
        if (end >= buffer.length || buffer[end] !== 0x0a) {
            throw new Error(`git cat-file --batch returned a truncated blob ${id}`)
        }
        try {
            blobs.set(id, UTF8_DECODER.decode(buffer.subarray(start, end)))
        } catch (error) {
            throw new GitBlobDecodeError(id, error)
        }
        counters.blobLoads += 1
        offset = end + 1
    }
    return blobs
}

export function createGitAdapter({ cwd, run = createGitRunner(cwd) } = {}) {
    const counters = { gitCalls: 0, blobLoads: 0 }

    function call(args, options) {
        counters.gitCalls += 1
        return run(args, options)
    }

    return {
        counters,

        resolveRevision(revision) {
            const result = call(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
                expectedExitCodes: [1],
            })
            const id = result.stdout.toString('utf8').trim()
            return id.length > 0 ? id : undefined
        },

        isAncestor(ancestor, descendant) {
            return (
                call(['merge-base', '--is-ancestor', ancestor, descendant], {
                    expectedExitCodes: [1],
                }).status === 0
            )
        },

        isShallow() {
            const result = call(['rev-parse', '--is-shallow-repository'])
            return result.stdout.toString('utf8').trim() === 'true'
        },

        hasLegacyGrafts() {
            const result = call(['rev-parse', '--git-path', 'info/grafts'])
            const path = result.stdout.toString('utf8').trim()
            try {
                return readFileSync(resolve(cwd ?? process.cwd(), path), 'utf8')
                    .split(/\r?\n/u)
                    .some((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'))
            } catch (error) {
                if (error.code === 'ENOENT') return false
                throw error
            }
        },

        firstParentChain(revision) {
            const result = call(['rev-list', '--first-parent', revision])
            return result.stdout.toString('utf8').split('\n').filter(Boolean)
        },

        // Path limiting keeps unrelated commits out of the walk without hiding a revision
        // that changed the locale directory, so non-i18n work between two locale commits
        // costs nothing.
        firstParentRevisions(baseline, revision, path) {
            const result = call([
                'rev-list',
                '--first-parent',
                '--reverse',
                `${baseline}..${revision}`,
                '--',
                path,
            ])
            return result.stdout.toString('utf8').split('\n').filter(Boolean)
        },

        treeBlobs(revision, path) {
            const result = call(['ls-tree', '-r', '-z', revision, '--', path])
            const entries = new Map()
            for (const line of splitNulTerminated(result.stdout)) {
                const tab = line.indexOf('\t')
                const [, type, id] = line.slice(0, tab).split(' ')
                if (type !== 'blob') continue
                entries.set(line.slice(tab + 1), id)
            }
            return entries
        },

        // Stage entries other than 0 mean an unresolved conflict, which cannot describe one
        // prospective tree, so they are reported rather than guessed at.
        indexBlobs(path) {
            const result = call(['ls-files', '--stage', '-z', '--', path])
            const entries = new Map()
            const conflicted = new Set()
            for (const line of splitNulTerminated(result.stdout)) {
                const tab = line.indexOf('\t')
                const [, id, stage] = line.slice(0, tab).split(' ')
                const file = line.slice(tab + 1)
                if (stage !== '0') {
                    conflicted.add(file)
                    continue
                }
                entries.set(file, id)
            }
            return { entries, conflicted: [...conflicted] }
        },

        stagedChangedPaths() {
            const result = call(['diff', '--cached', '--name-only', '-z'])
            return splitNulTerminated(result.stdout)
        },

        readBlobs(ids) {
            if (ids.length === 0) return new Map()
            const result = call(['cat-file', '--batch'], { input: `${ids.join('\n')}\n` })
            return parseBatchOutput(result.stdout, counters)
        },
    }
}

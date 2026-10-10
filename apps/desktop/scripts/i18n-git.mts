import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The whole history engine reaches Git through this module. Everything above it works on
// plain snapshots, so transition analysis stays pure and tests can count how often blobs
// are actually read.

type GitResult = { status: number; stdout: Buffer; stderr: Buffer }
export type GitRunOptions = { input?: string | Buffer; expectedExitCodes?: number[] }
export type GitRunner = (args: string[], options?: GitRunOptions) => GitResult
type ExecError = Error & { status?: number | null; stdout?: Buffer; stderr?: Buffer }
type GitCounters = { gitCalls: number; blobLoads: number }
type BlobObservation = string | GitBlobDecodeError

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export class GitCommandError extends Error {
    args: string[]
    status: number | null | undefined
    constructor(args: string[], cause: ExecError) {
        const stderr = cause.stderr?.toString('utf8').trim()
        super(`git ${args.join(' ')} failed: ${stderr || cause.message}`)
        this.name = 'GitCommandError'
        this.args = args
        this.status = cause.status
        this.cause = cause
    }
}

export class GitBlobDecodeError extends Error {
    oid: string
    constructor(oid: string, cause: unknown) {
        super(`Git blob ${oid} is not valid UTF-8`, { cause })
        this.name = 'GitBlobDecodeError'
        this.oid = oid
    }
}

export function createGitRunner(cwd: string): GitRunner {
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
            const cause = error as ExecError
            if (
                cause.status !== undefined &&
                cause.status !== null &&
                expectedExitCodes.includes(cause.status)
            ) {
                return {
                    status: cause.status,
                    stdout: cause.stdout ?? Buffer.alloc(0),
                    stderr: cause.stderr ?? Buffer.alloc(0),
                }
            }
            throw new GitCommandError(args, cause)
        }
    }
}

function splitNulTerminated(buffer: Buffer) {
    return buffer.toString('utf8').split('\0').filter(Boolean)
}

// git cat-file --batch answers each requested id with a header line followed by exactly
// <size> bytes and one newline. Sizes are byte counts, so the payload has to be sliced off
// the raw buffer rather than off a decoded string.
function parseBatchOutput(buffer: Buffer, counters: GitCounters): Map<string, BlobObservation> {
    const blobs = new Map<string, BlobObservation>()
    let offset = 0
    while (offset < buffer.length) {
        const newline = buffer.indexOf(0x0a, offset)
        if (newline === -1) throw new Error('git cat-file --batch returned a truncated header')
        const header = buffer.toString('utf8', offset, newline)
        const [id, type, size] = header.split(' ')
        if (id === undefined || type === undefined || size === undefined) {
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
            blobs.set(id, new GitBlobDecodeError(id, error))
        }
        counters.blobLoads += 1
        offset = end + 1
    }
    return blobs
}

export function createGitAdapter({
    cwd = process.cwd(),
    run = createGitRunner(cwd),
}: { cwd?: string; run?: GitRunner } = {}) {
    const counters = { gitCalls: 0, blobLoads: 0 }

    function call(args: string[], options?: GitRunOptions) {
        counters.gitCalls += 1
        return run(args, options)
    }

    return {
        counters,

        resolveRevision(revision: string) {
            const result = call(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
                expectedExitCodes: [1],
            })
            const id = result.stdout.toString('utf8').trim()
            return id.length > 0 ? id : undefined
        },

        isAncestor(ancestor: string, descendant: string) {
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
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                    return false
                throw error
            }
        },

        firstParentChain(revision: string) {
            const result = call(['rev-list', '--first-parent', revision])
            return result.stdout.toString('utf8').split('\n').filter(Boolean)
        },

        // Path limiting keeps unrelated commits out of the walk without hiding a revision
        // that changed the locale directory, so non-i18n work between two locale commits
        // costs nothing.
        firstParentRevisions(baseline: string, revision: string, path: string) {
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

        treeBlobs(revision: string, path: string) {
            const result = call(['ls-tree', '-r', '-z', revision, '--', path])
            const entries = new Map<string, string>()
            for (const line of splitNulTerminated(result.stdout)) {
                const tab = line.indexOf('\t')
                const [, type, id] = line.slice(0, tab).split(' ')
                if (type !== 'blob') continue
                if (tab < 0 || !id) throw new Error('git ls-tree returned an invalid blob entry')
                entries.set(line.slice(tab + 1), id)
            }
            return entries
        },

        treesAtRevisions(revisions: string[], path: string) {
            if (revisions.length === 0) return new Map()
            const entries = this.treeBlobs(revisions[0]!, path)
            const trees = new Map([[revisions[0], new Map(entries)]])
            if (revisions.length === 1) return trees
            const input = revisions
                .slice(1)
                .map((revision, index) => revision + ' ' + revisions[index] + '\n')
                .join('')
            const result = call(
                [
                    'diff-tree',
                    '--stdin',
                    '--raw',
                    '-r',
                    '-z',
                    '--no-renames',
                    '--no-abbrev',
                    '--no-ext-diff',
                    '--no-textconv',
                    '--',
                    path,
                ],
                { input }
            )
            if (result.stdout.length > 0 && result.stdout.at(-1) !== 0)
                throw new Error('git diff-tree returned a non-terminated record')
            const fields = result.stdout.toString('utf8').split('\0')
            let index = 0
            function save() {
                trees.set(
                    revisions[index],
                    new Map(
                        [...entries].sort(([left], [right]) =>
                            Buffer.compare(Buffer.from(left), Buffer.from(right))
                        )
                    )
                )
            }
            for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
                const field = fields[fieldIndex]!
                if (field === '') {
                    if (fieldIndex !== fields.length - 1)
                        throw new Error('git diff-tree returned an empty record')
                    continue
                }
                if (!field.startsWith(':')) {
                    if (index > 0) save()
                    index += 1
                    if (field !== revisions[index])
                        throw new Error('git diff-tree returned an unexpected revision ' + field)
                    continue
                }
                if (index === 0) throw new Error('git diff-tree returned changes before a revision')
                const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(field)
                if (!match)
                    throw new Error('git diff-tree returned an invalid change record ' + field)
                const oldMode = match[1]!
                const newMode = match[2]!
                const oldId = match[3]!
                const newId = match[4]!
                const name = fields[++fieldIndex]
                if (!name || (name !== path && !name.startsWith(path + '/')))
                    throw new Error('git diff-tree returned an invalid path')
                if (oldMode !== '000000' && oldMode !== '160000' && entries.get(name) !== oldId)
                    throw new Error('git diff-tree disagrees with the preceding tree for ' + name)
                if (newMode === '000000' || newMode === '160000') {
                    entries.delete(name)
                    continue
                }
                if (!['100644', '100755', '120000'].includes(newMode))
                    throw new Error('git diff-tree returned unsupported mode ' + newMode)
                entries.set(name, newId)
            }
            if (index !== revisions.length - 1)
                throw new Error('git diff-tree returned an incomplete revision sequence')
            save()
            return trees
        },

        // Stage entries other than 0 mean an unresolved conflict, which cannot describe one
        // prospective tree, so they are reported rather than guessed at.
        indexBlobs(path: string) {
            const result = call(['ls-files', '--stage', '-z', '--', path])
            const entries = new Map()
            const conflicted = new Set<string>()
            for (const line of splitNulTerminated(result.stdout)) {
                const tab = line.indexOf('\t')
                const [, id, stage] = line.slice(0, tab).split(' ')
                const file = line.slice(tab + 1)
                if (tab < 0 || !id) throw new Error('git ls-files returned an invalid index entry')
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

        // Working tree against a recorded commit, including files that are not staged and
        // files Git is not tracking at all. An untracked locale file is invisible to diff, but
        // staging an owned directory would sweep it into the commit, so it counts as changed.
        changedPathsSince(revision: string) {
            const tracked = call(['diff', '--name-only', '-z', revision])
            const untracked = call(['ls-files', '--others', '--exclude-standard', '-z'])
            return [
                ...new Set([
                    ...splitNulTerminated(tracked.stdout),
                    ...splitNulTerminated(untracked.stdout),
                ]),
            ].sort()
        },

        readBlobObservations(ids: string[]): Map<string, BlobObservation> {
            if (ids.length === 0) return new Map()
            const result = call(['cat-file', '--batch'], { input: ids.join('\n') + '\n' })
            return parseBatchOutput(result.stdout, counters)
        },

        readBlobs(ids: string[]): Map<string, string> {
            const observations = this.readBlobObservations(ids)
            const blobs = new Map<string, string>()
            for (const [id, value] of observations) {
                if (value instanceof GitBlobDecodeError) throw value
                blobs.set(id, value)
            }
            return blobs
        },
    }
}

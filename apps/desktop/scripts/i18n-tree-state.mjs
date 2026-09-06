import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitRunner } from './i18n-git.mjs'

// The writer proves its generators reach a fixed point by describing the working tree before
// and after a second pass and requiring the two descriptions to match. That only works if the
// description covers content: git status lists an untracked file by name alone, so a second
// pass that rewrites a file the first pass created would otherwise look like no change at all.
// Hashing every differing path also makes the comparison binary-safe, which a diff is not.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const RENAME_CODES = new Set(['R', 'C'])

function splitNul(text) {
    return text.split('\0').filter(Boolean)
}

// git status --porcelain=v1 -z emits "XY <path>" per entry, and a rename or copy follows it
// with the original path as its own field. Consuming that extra field keeps the origin from
// being read as a separate entry with a nonsense status.
function parseStatus(text) {
    const fields = splitNul(text)
    const entries = []
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]
        const code = field.slice(0, 2)
        const path = field.slice(3)
        if (RENAME_CODES.has(code[0]) || RENAME_CODES.has(code[1])) {
            const origin = fields[index + 1]
            index += 1
            entries.push({ code, path, origin })
            continue
        }
        entries.push({ code, path })
    }
    return entries
}

function contentHash(cwd, path) {
    try {
        return createHash('sha256')
            .update(readFileSync(join(cwd, path)))
            .digest('hex')
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') return 'absent'
        throw error
    }
}

/**
 * A deterministic, content-addressed description of everything in the working tree that differs
 * from HEAD, staged or not, tracked or not. Two runs that describe the same bytes produce the
 * same string.
 */
export function describeWorkingTree({ cwd = REPOSITORY_ROOT, run = createGitRunner(cwd) } = {}) {
    const status = run(['status', '--porcelain=v1', '--untracked-files=all', '-z'])
    return parseStatus(status.stdout.toString('utf8'))
        .map(({ code, path, origin }) => {
            const from = origin ? ` <- ${origin}` : ''
            return `${code} ${contentHash(cwd, path)} ${path}${from}`
        })
        .sort()
        .join('\n')
}

export function runI18nTreeState(
    args,
    { stdout = process.stdout, stderr = process.stderr, ...options } = {}
) {
    if (args.length > 0) {
        stderr.write('Usage: node scripts/i18n-tree-state.mjs\n')
        return 2
    }
    stdout.write(`${describeWorkingTree(options)}\n`)
    return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runI18nTreeState(process.argv.slice(2))
}

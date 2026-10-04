import type { CliIO } from './i18n-io.mts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitRunner, type GitRunner } from './i18n-git.mts'

// Fixed-point verification must compare content, including untracked files. Git status lists
// them by name alone and would miss a generator rewriting its own newly created output.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const RENAME_CODES = new Set(['R', 'C'])

function splitNul(text: string) {
    return text.split('\0').filter(Boolean)
}

// git status --porcelain=v1 -z emits "XY <path>" per entry, and a rename or copy follows it
// with the original path as its own field. Consuming that extra field keeps the origin from
// being read as a separate entry with a nonsense status.
function parseStatus(text: string) {
    const fields = splitNul(text)
    const entries: { code: string; path: string; origin?: string }[] = []
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]!
        const code = field.slice(0, 2)
        const path = field.slice(3)
        if (RENAME_CODES.has(code[0]!) || RENAME_CODES.has(code[1]!)) {
            const origin = fields[index + 1]
            index += 1
            entries.push({ code, path, origin })
            continue
        }
        entries.push({ code, path })
    }
    return entries
}

function contentHash(cwd: string, path: string) {
    try {
        return createHash('sha256')
            .update(readFileSync(join(cwd, path)))
            .digest('hex')
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'EISDIR')
        )
            return 'absent'
        throw error
    }
}

/**
 * A deterministic, content-addressed description of everything in the working tree that differs
 * from HEAD, staged or not, tracked or not. Two runs that describe the same bytes produce the
 * same string.
 */
export function describeWorkingTree({
    cwd = REPOSITORY_ROOT,
    run = createGitRunner(cwd),
}: { cwd?: string; run?: GitRunner } = {}) {
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
    args: string[],
    {
        stdout = process.stdout,
        stderr = process.stderr,
        ...options
    }: CliIO & { cwd?: string; run?: GitRunner } = {}
) {
    if (args.length > 0) {
        stderr.write('Usage: bun scripts/i18n-tree-state.mts\n')
        return 2
    }
    stdout.write(`${describeWorkingTree(options)}\n`)
    return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runI18nTreeState(process.argv.slice(2))
}

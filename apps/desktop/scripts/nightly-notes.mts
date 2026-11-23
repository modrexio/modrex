import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectNotes, createGitHub, readCoAuthors, renderNightly } from './changes.mts'
import { errorMessage } from './error-message.mts'

// The argument is the commit the previous nightly was built from. nightly.yml passes an empty
// string before the first nightly exists, and then every entry counts as new.
const previous = process.argv[2]
if (process.argv.length !== 3 || previous === undefined) {
    console.error('Usage: bun scripts/nightly-notes.mts <previous nightly commit or "">')
    process.exit(1)
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

try {
    const notes = collectNotes({
        repoRoot,
        github: createGitHub(),
        coAuthors: readCoAuthors(repoRoot),
        unknownCoAuthors: 'skip',
        warn: (message) => console.error(`Warning: ${message}`),
    })
    const range = previous ? `${previous}..HEAD` : 'HEAD'
    const since = execFileSync('git', ['rev-list', range], { cwd: repoRoot, encoding: 'utf8' })
    process.stdout.write(`${renderNightly(notes, new Set(since.trim().split('\n')))}\n`)
} catch (error) {
    console.error(`Nightly notes failed: ${errorMessage(error)}`)
    process.exit(1)
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGES_DIR, readChanges, readCoAuthors } from './changes.mts'
import { errorMessage } from './i18n-io.mts'

// Checks the change files offline. The GitHub lookups only run when notes are rendered.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

try {
    const changes = readChanges(repoRoot)
    readCoAuthors(repoRoot)
    // A branch started before change files existed can still add an Unreleased section, which
    // the release script would never read.
    if (/^## Unreleased$/m.test(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'))) {
        throw new Error(
            `CHANGELOG.md has an Unreleased section. Write each entry as a file in ${CHANGES_DIR}/ instead, see docs/contributing/changelog.md`
        )
    }
    console.log(`Change files OK (${changes.length} unreleased).`)
} catch (error) {
    console.error(`Change check failed:\n${errorMessage(error)}`)
    process.exit(1)
}

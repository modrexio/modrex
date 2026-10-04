import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { execSync } from 'child_process'

// PostToolUse hook: format the file Claude just wrote with the owning repo's
// prettier, so pre-commit format checks never fail on agent edits. Files outside
// a prettier-configured repo are skipped.

const input = JSON.parse(readFileSync(0, 'utf8'))
const file = input.tool_input?.file_path
if (!file || !existsSync(file)) process.exit(0)

let dir = dirname(file)
let root = null
for (;;) {
    if (existsSync(join(dir, '.prettierrc'))) {
        root = dir
        break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
}
if (!root) process.exit(0)

try {
    execSync(`bun --bun x prettier --write --ignore-unknown "${file}"`, {
        cwd: root,
        stdio: 'ignore',
    })
} catch {
    process.exit(0)
}

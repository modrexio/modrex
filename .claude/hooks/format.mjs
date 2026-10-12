import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { execSync } from 'child_process'

// PostToolUse hook: format the file Claude just wrote with the formatter that owns it, so
// pre-commit format checks never fail on agent edits. apps/site keeps Prettier until oxfmt
// formats .astro files, and everything else uses the root oxfmt config. Files outside a
// configured directory are skipped.

const formatters = [
    ['.prettierrc.json', (file) => `bun --bun x prettier --write --ignore-unknown "${file}"`],
    ['.oxfmtrc.json', (file) => `bun --bun x oxfmt --no-error-on-unmatched-pattern "${file}"`],
]

const input = JSON.parse(readFileSync(0, 'utf8'))
const file = input.tool_input?.file_path
if (!file || !existsSync(file)) process.exit(0)

let dir = dirname(file)
let match = null
for (;;) {
    const found = formatters.find(([config]) => existsSync(join(dir, config)))
    if (found) {
        match = { root: dir, command: found[1](file) }
        break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
}
if (!match) process.exit(0)

try {
    execSync(match.command, { cwd: match.root, stdio: 'ignore' })
} catch {
    process.exit(0)
}

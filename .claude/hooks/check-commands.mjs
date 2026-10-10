import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// PostToolUse hook: when api.ts or lib.rs changes, run the command-registration
// check immediately so a mismatch surfaces to Claude at edit time instead of at
// commit time. Exit 2 feeds the check output back as a blocking error.

const input = JSON.parse(readFileSync(0, 'utf8'))
const file = (input.tool_input?.file_path ?? '').replace(/\\/g, '/')
const suffixes = ['/src/renderer/src/api.ts', '/src-tauri/src/lib.rs']
const suffix = suffixes.find((s) => file.endsWith(s))
if (!suffix) process.exit(0)

const root = file.slice(0, -suffix.length)
try {
    execSync('bun run check-commands', { cwd: root, stdio: 'pipe' })
} catch (e) {
    console.error(String(e.stdout ?? '') + String(e.stderr ?? ''))
    process.exit(2)
}

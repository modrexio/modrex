import { readFileSync } from 'fs'

const version = process.argv[2]
if (!version) {
    console.error('Usage: bun scripts/changelog-section.mjs <version>')
    process.exit(1)
}

const changelog = readFileSync('../../CHANGELOG.md', 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const match = changelog.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`))

if (!match) {
    console.error(`Warning: no CHANGELOG.md section found for ${version}`)
    process.exit(0)
}

process.stdout.write(match[1].trim() + '\n')

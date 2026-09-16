import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')

function findLicenseText(pkgPath) {
    let files
    try {
        files = readdirSync(pkgPath)
    } catch {
        return null
    }
    const match = files.find((f) => /^licen[sc]e(\.txt|\.md)?$/i.test(f))
    if (!match) return null

    const licensePath = join(pkgPath, match)
    return statSync(licensePath).isFile() ? readFileSync(licensePath, 'utf-8').trim() : null
}

const raw = execSync('pnpm --filter modrex licenses list --prod --json', {
    cwd: rootDir,
}).toString()
const npmData = JSON.parse(raw)

let npmLines = []
const seen = new Set()

for (const packages of Object.values(npmData)) {
    for (const pkg of packages) {
        if (seen.has(pkg.name)) continue
        seen.add(pkg.name)

        const text = pkg.paths?.[0] ? findLicenseText(pkg.paths[0]) : null
        npmLines.push(`### ${pkg.name} ${pkg.versions?.[0] ?? ''}`)
        npmLines.push(``)
        npmLines.push(`**License:** ${pkg.license}`)
        npmLines.push(``)
        if (text) {
            npmLines.push('```')
            npmLines.push(text)
            npmLines.push('```')
        }
        npmLines.push(``)
        npmLines.push('---')
        npmLines.push(``)
    }
}

// The pre-commit hook stages whatever this writes, so a missing tool must stop the
// commit rather than produce a file with the Rust section gone.
const rustTmp = join(rootDir, 'src-tauri', '_rust-licenses.tmp.md')
let rustLines = []
try {
    execSync(`cargo about generate about.hbs -o "${rustTmp}"`, {
        cwd: join(rootDir, 'src-tauri'),
        stdio: 'pipe',
    })
    rustLines = readFileSync(rustTmp, 'utf-8').split('\n')
    unlinkSync(rustTmp)
} catch (e) {
    console.error('cargo-about failed, THIRD_PARTY_LICENSES.md left unchanged:', e.message)
    console.error('Install it with: cargo install cargo-about --features=cli')
    process.exit(1)
}

const header = [
    '# Third-Party Licenses',
    '',
    'This file lists all third-party dependencies bundled in Modrex and their license terms.',
    'Regenerate with `pnpm generate-licenses`.',
    '',
    '---',
    '',
    '## JavaScript / TypeScript Dependencies',
    '',
]

const rustHeader = ['## Rust / C Dependencies', '']

// Reference implementations whose code/data is embedded but not managed by a package manager.
const referenceHeader = ['## Reference Implementations', '']
const referenceLines = [
    '### PDModExtractor (HW12Dev)',
    '',
    '**Repository:** https://github.com/HW12Dev/PDModExtractor  ',
    '**License:** MIT  ',
    '**Used for:** The `.pdmod` extraction algorithm in `src-tauri/src/commands/mods/pdmod.rs` and the',
    'bundled asset hashlist (`pdmod_hashlist.txt`) are both derived from this project. The Bob Jenkins',
    'lookup8 hash function is a Rust port of `src/hash.cpp`; the extraction logic mirrors `src/main.cpp`.',
    '',
    '```',
    'MIT License',
    '',
    'Copyright (c) HW12Dev',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '```',
    '',
]

const output = [
    ...header,
    ...npmLines,
    ...rustHeader,
    ...rustLines,
    ...referenceHeader,
    ...referenceLines,
].join('\n')
writeFileSync(join(rootDir, 'THIRD_PARTY_LICENSES.md'), output)
console.log('Written THIRD_PARTY_LICENSES.md')

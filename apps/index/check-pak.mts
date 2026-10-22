import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const APP_DB = 'C:/Users/oleh/AppData/Roaming/Modrex/mod-index.db'
const pakPath = process.argv[2]
if (!pakPath) {
    console.log('Usage: bun check-pak.mts <path-to-pak-file>')
    process.exit(1)
}

const buf = readFileSync(pakPath)
const sha256 = createHash('sha256').update(buf).digest('hex')
console.log('SHA256:', sha256)

// Check magic bytes
const magic = buf.slice(0, 4)
console.log('Magic bytes:', [...magic].map((b) => b.toString(16).padStart(2, '0')).join(' '))
if (magic[0] === 0x50 && magic[1] === 0x4b) console.log('  -> This is a ZIP file, not a real pak!')
else console.log('  -> Looks like a real pak (not a ZIP)')

const db = new Database(APP_DB, { readonly: true })
const row = db
    .prepare<[string], { name: string; remote_id: number; file_id: number; version: string }>(
        `
    SELECT m.name, m.remote_id, f.remote_id as file_id, f.version
    FROM files f JOIN mods m ON m.id = f.mod_id
    WHERE f.sha256 = ?
`
    )
    .get(sha256)

if (row) {
    console.log(
        `\nFound in index: "${row.name}" (mod=${row.remote_id} file=${row.file_id} v${row.version})`
    )
} else {
    console.log('\nNot found in index.')
    // Check if this SHA256 is close to any mod (by searching name)
    console.log('(SHA256 not in index — possible version mismatch or extraction difference)')
}
db.close()

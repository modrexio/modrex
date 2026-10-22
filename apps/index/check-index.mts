import Database from 'better-sqlite3'

const APP_DB = 'C:/Users/oleh/AppData/Roaming/Modrex/mod-index.db'

const db = new Database(APP_DB, { readonly: true })
const count = db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM files').get()!
const meta = db
    .prepare<[], { value: string }>("SELECT value FROM metadata WHERE key='last_run_at'")
    .get()
console.log('Total files indexed:', count.n)
console.log('Last run at:', meta?.value ?? 'never')

// Show a sample of recent entries to see if any came from ZIPs (same remote_id, different sha256)
const dupes = db
    .prepare<[], { name: string; remote_id: number; pak_count: number }>(
        `
    SELECT m.name, f.remote_id, COUNT(*) as pak_count
    FROM files f JOIN mods m ON m.id = f.mod_id
    GROUP BY f.mod_id, f.remote_id
    HAVING pak_count > 1
    LIMIT 10
`
    )
    .all()
console.log('\nFiles with multiple pak hashes (ZIP-extracted):')
if (dupes.length === 0) console.log('  none — ZIP extraction not yet in this index')
else
    dupes.forEach((r) =>
        console.log(`  mod="${r.name}" file_id=${r.remote_id} paks=${r.pak_count}`)
    )

db.close()

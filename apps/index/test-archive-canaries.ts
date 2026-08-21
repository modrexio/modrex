// Real ModWorkshop RAR4 archives that crash Ubuntu's distro 7-Zip; the pinned build in
// install-7zip.sh must decode them correctly. Network- and extractor-dependent, so this
// runs on demand rather than folding into index:test, which stays offline and hermetic.

import { strict as assert } from 'node:assert'

import { extractMarkerEntry } from './postgres/marker-archive.js'

const canaries = [
    {
        url: 'https://storage.modworkshop.net/mods/files/download_37_1442094920_d60fea55e86fdd548d83e4f1067764a9.rar',
        entryName: 'Hotline Combo BLT/mod.txt',
    },
    {
        url: 'https://storage.modworkshop.net/mods/files/download_575_1442103921_83d353e87af66f37297e738ad4a0dfb2.rar',
        entryName:
            'NPCs/units/payday2/characters/shared_textures/helmets_heavy_taser_atlas_df.texture',
    },
]

for (const { url, entryName } of canaries) {
    const entry = await extractMarkerEntry(url, null)
    assert.ok(entry, `${url} must extract a marker entry`)
    assert.equal(entry.entryName, entryName, `${url} must pick ${entryName}`)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${url} must produce a sha256 digest`)
}

console.log('archive canary extraction test passed')

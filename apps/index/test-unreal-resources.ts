// Archive shapes mirror real ModWorkshop uploads: intro packs shipping one blank movie under
// several slot names, and a preset with mutually exclusive Engine.ini alternatives.

import AdmZip from 'adm-zip'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { extractContentEntries } from './postgres/content-archive.js'
import { UnusableDownloadError } from './postgres/marker-archive.js'
import { hostedSourceFilename, parseFile } from './postgres/modworkshop.js'
import { classifyResource, isResourceName } from './postgres/unreal-resource.js'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// Stand-in movie bytes. Recognition never parses them, so any payload works.
const blankMovie = Buffer.alloc(64, 0x42)
const smallUi = Buffer.from('[/Script/Engine.UserInterfaceSettings]\r\nApplicationScale=0.6\r\n')
const html = Buffer.from('<!DOCTYPE html><title>Download</title>')

assert.equal(isResourceName('Content/Movies/StartUp_SBZ.bk2'), true)
assert.equal(isResourceName('UE4_LOGO.BK2'), true)
assert.equal(isResourceName('6/Engine.ini'), true)
assert.equal(isResourceName('Movies/StartUp_SBZ.bak2'), false, '.bak2 is not a movie alias')
assert.equal(classifyResource('Movies/StartUp_SBZ.bak2', blankMovie), null)
assert.equal(classifyResource('Mod_P.pak', blankMovie), null)
assert.equal(classifyResource('object', blankMovie), null, 'no extension and no advertised kind')

assert.deepEqual(classifyResource('Movies/UE4_LOGO.BK2', blankMovie), {
    kind: 'movie',
    byteLength: 64,
})
assert.deepEqual(classifyResource('6/Engine.INI', smallUi), {
    kind: 'config',
    byteLength: smallUi.length,
})
assert.deepEqual(
    classifyResource('ue4ss/UE4SS-settings.ini', smallUi),
    { kind: 'config', byteLength: smallUi.length },
    'any INI is recognisable, not only Engine.ini'
)
assert.deepEqual(
    classifyResource('Movies/Intro.bk2', Buffer.alloc(0)),
    { kind: 'movie', byteLength: 0 },
    'a zero-byte deletion substitute is kept'
)
assert.deepEqual(
    classifyResource('Movies/Intro.bk2', html),
    { kind: 'movie', byteLength: html.length },
    'an HTML page served in place of a movie is kept for exact recognition'
)
assert.deepEqual(classifyResource('object', html, 'movie'), {
    kind: 'movie',
    byteLength: html.length,
})
assert.deepEqual(classifyResource('object', smallUi, 'config'), {
    kind: 'config',
    byteLength: smallUi.length,
})

const names = { objectName: '43903_1_object.zip', sourceFilename: 'Skip Startup.zip' }

{
    const temp = mkdtempSync(join(tmpdir(), 'modrex-resource-limits-'))
    const pak = Buffer.from('ordinary package')
    const oversized = Buffer.alloc(1024 * 1024 + 1)
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (message) => warnings.push(String(message))
    try {
        const zip = new AdmZip()
        for (const [name, bytes] of [
            ['Payload.pak', pak],
            ['Engine.ini', oversized],
            ['Intro.bk2', blankMovie],
        ] as const) {
            zip.addFile(name, bytes)
            writeFileSync(join(temp, name), bytes)
        }
        const sevenZip = join(temp, 'mixed.7z')
        execFileSync('7z', ['a', '-t7z', sevenZip, 'Payload.pak', 'Engine.ini', 'Intro.bk2'], {
            cwd: temp,
            stdio: 'ignore',
        })
        for (const archive of [zip.toBuffer(), readFileSync(sevenZip)]) {
            const entries = extractContentEntries(archive, names)
            assert.deepEqual(
                entries.map((entry) => entry.entryName).sort(),
                ['Intro.bk2', 'Payload.pak'],
                warnings.join('\n')
            )
            assert.equal(
                entries.find((entry) => entry.entryName === 'Payload.pak')?.sha256,
                sha256(pak)
            )
            assert.equal(
                entries.find((entry) => entry.entryName === 'Intro.bk2')?.sha256,
                sha256(blankMovie)
            )
        }
        assert.equal(warnings.length, 2)
        assert.ok(
            warnings.every((message) => message.includes('Engine.ini') && message.includes('limit'))
        )
    } finally {
        console.warn = warn
        assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + (temp.includes('\\') ? '\\' : '/')))
        rmSync(temp, { recursive: true, force: true })
    }
}

{
    const zip = new AdmZip()
    for (const slot of [
        'ARC_25FPS.bk2',
        'cs_splash_505_igs_crimeboss.bk2',
        'logo_arc_4k_60fps.bk2',
        'UE4_Logo.bk2',
    ])
        zip.addFile(`CrimeBoss/Content/Movies/${slot}`, blankMovie)
    zip.addFile('CrimeBoss/Content/Movies/UE4_Logo.bak2', blankMovie)
    zip.addFile('CrimeBoss/Content/Paks/~mods/Mod_P.pak', Buffer.from('pak bytes'))
    zip.addFile('README.txt', Buffer.from('copy to Movies'))
    zip.addFile('empty/Engine.ini', Buffer.alloc(0))
    zip.addFile('broken/Broken.bk2', Buffer.from('BIKi'))

    const entries = extractContentEntries(zip.toBuffer(), names)
    const movies = entries.filter((entry) => entry.resource?.kind === 'movie')
    assert.deepEqual(
        movies.map((entry) => entry.entryName).sort(),
        [
            'CrimeBoss/Content/Movies/ARC_25FPS.bk2',
            'CrimeBoss/Content/Movies/cs_splash_505_igs_crimeboss.bk2',
            'CrimeBoss/Content/Movies/logo_arc_4k_60fps.bk2',
            'CrimeBoss/Content/Movies/UE4_Logo.bk2',
            'broken/Broken.bk2',
        ].sort(),
        'every slot name survives even when the bytes are identical'
    )
    assert.deepEqual(
        [
            ...new Set(
                movies
                    .filter((entry) => entry.entryName.startsWith('CrimeBoss/'))
                    .map((entry) => entry.sha256)
            ),
        ],
        [sha256(blankMovie)],
        'identical slot bytes share one exact hash'
    )
    assert.deepEqual(
        movies.find((entry) => entry.entryName === 'broken/Broken.bk2'),
        {
            sha256: sha256(Buffer.from('BIKi')),
            entryName: 'broken/Broken.bk2',
            resource: { kind: 'movie', byteLength: 4 },
        },
        'a malformed movie is collected with its exact hash'
    )
    assert.deepEqual(
        entries.find((entry) => entry.entryName === 'empty/Engine.ini'),
        {
            sha256: sha256(Buffer.alloc(0)),
            entryName: 'empty/Engine.ini',
            resource: { kind: 'config', byteLength: 0 },
        },
        'an empty published config is collected with its exact hash'
    )
    assert.deepEqual(
        entries.filter((entry) => !entry.resource),
        [
            {
                sha256: sha256(Buffer.from('pak bytes')),
                entryName: 'CrimeBoss/Content/Paks/~mods/Mod_P.pak',
            },
        ],
        'pak entries keep their established shape'
    )
    assert.equal(entries.length, 7, 'README and .bak2 entries are not collected')
}

{
    const zip = new AdmZip()
    for (const scale of ['6', '7', '8', '9'])
        zip.addFile(
            `${scale}/Engine.ini`,
            Buffer.from(`[/Script/Engine.UserInterfaceSettings]\r\nApplicationScale=0.${scale}\r\n`)
        )
    const entries = extractContentEntries(zip.toBuffer(), names)
    assert.deepEqual(
        entries.map((entry) => [entry.entryName, entry.resource?.kind]),
        [
            ['6/Engine.ini', 'config'],
            ['7/Engine.ini', 'config'],
            ['8/Engine.ini', 'config'],
            ['9/Engine.ini', 'config'],
        ],
        'each alternative is its own catalog entry'
    )
    assert.equal(new Set(entries.map((entry) => entry.sha256)).size, 4)
}

{
    assert.deepEqual(
        extractContentEntries(blankMovie, {
            objectName: '46731_1_object.bk2',
            sourceFilename: 'MCRTheBlackParade.bk2',
        }),
        [
            {
                sha256: sha256(blankMovie),
                entryName: 'MCRTheBlackParade.bk2',
                resource: { kind: 'movie', byteLength: 64 },
            },
        ],
        'a loose movie is named by its hosted filename'
    )
    assert.equal(
        extractContentEntries(blankMovie, { objectName: 'object.bk2', sourceFilename: null })[0]
            .entryName,
        'object.bk2',
        'without a hosted filename the storage object names the loose resource'
    )
    const pak = Buffer.from('raw pak')
    assert.deepEqual(
        extractContentEntries(pak, { objectName: 'object.pak', sourceFilename: 'Mod_P.pak' }),
        [{ sha256: sha256(pak), entryName: 'object.pak' }],
        'the raw pak fallback is unchanged'
    )
    assert.deepEqual(
        extractContentEntries(html, { objectName: 'object', sourceFilename: 'Intro.bk2' }),
        [
            {
                sha256: sha256(html),
                entryName: 'Intro.bk2',
                resource: { kind: 'movie', byteLength: html.length },
            },
        ],
        'HTML published as a movie is collected as a movie with its exact hash'
    )
    assert.deepEqual(
        extractContentEntries(html, { objectName: 'object', sourceFilename: 'Mod.pak' }),
        [{ sha256: sha256(html), entryName: 'object' }],
        'pak validation is not tightened'
    )
    assert.deepEqual(
        extractContentEntries(html, {
            objectName: 'object',
            sourceFilename: null,
            advertisedKind: 'movie',
        }),
        [
            {
                sha256: sha256(html),
                entryName: 'object',
                resource: { kind: 'movie', byteLength: html.length },
            },
        ],
        'advertised movies without an extension stay outside the legacy files projection'
    )
    assert.throws(
        () =>
            extractContentEntries(Buffer.alloc(1024 * 1024 + 1), {
                objectName: 'object',
                sourceFilename: null,
                advertisedKind: 'config',
            }),
        UnusableDownloadError,
        'extensionless advertised configs use the config size limit'
    )
}

assert.throws(
    () =>
        extractContentEntries(
            Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0xff)]),
            names
        ),
    UnusableDownloadError,
    'a damaged archive is an explicit coverage failure, not an empty extraction'
)
{
    const zip = new AdmZip()
    const name = 'xx/Saved/Config/Engine.ini'
    zip.addFile(name, Buffer.from('[S]\nA=1\n'))
    const buffer = zip.toBuffer()
    for (
        let offset = buffer.indexOf(name);
        offset !== -1;
        offset = buffer.indexOf(name, offset + name.length)
    ) {
        buffer.write('..', offset)
    }
    assert.throws(
        () => extractContentEntries(buffer, names),
        UnusableDownloadError,
        'a zip resource escaping its archive is refused like a 7z or RAR one'
    )
}

{
    const file = parseFile({
        id: 102971,
        name: 'Club of the Necrodancer',
        file: 'mods/files/48828_164264_object.pak',
        size: 1,
        type: 'pak',
        version: '3.0',
        download_url:
            'https://storage.modworkshop.net/mods/files/48828_164264_object.pak?filename=Club%20of%20the%20Necrodancer.pak',
    })
    assert.equal(hostedSourceFilename(file), 'Club of the Necrodancer.pak')
    const hinted = (filename: string) =>
        hostedSourceFilename({
            ...file,
            download_url: `https://storage.test/object?filename=${encodeURIComponent(filename)}`,
        })
    assert.equal(hinted('../../Saved/Config/Engine.ini'), 'Engine.ini', 'only the last segment')
    assert.equal(hinted('..\\Engine.ini'), 'Engine.ini')
    assert.equal(hinted('In\u0000tro\n.bk2'), 'Intro.bk2')
    assert.equal(
        hinted('..'),
        'Club of the Necrodancer',
        'an unusable hint falls back to the label'
    )
    assert.equal(
        hostedSourceFilename({ ...file, download_url: 'https://storage.test/object' }),
        'Club of the Necrodancer'
    )
    assert.equal(hostedSourceFilename({ ...file, name: '', download_url: '' }), null)
    const unnamed = parseFile({
        id: 1,
        name: null,
        file: '',
        size: 1,
        type: 'zip',
        version: '',
        download_url: '',
    })
    assert.equal(unnamed.name, '')
}

console.log('Unreal resource collection tests passed')

// Archive shapes mirror real ModWorkshop uploads: intro packs shipping one blank movie under
// several slot names, and a preset with mutually exclusive Engine.ini alternatives.

import AdmZip from 'adm-zip'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'

import { extractContentEntries } from './postgres/content-archive.js'
import { UnusableDownloadError } from './postgres/marker-archive.js'
import { hostedSourceFilename, parseFile } from './postgres/modworkshop.js'
import { classifyResource, isResourceName } from './postgres/unreal-resource.js'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function bink(signature: 'BIK' | 'KB2', length = 64): Buffer {
    const bytes = Buffer.alloc(length)
    bytes.write(`${signature}i`, 0, 'latin1')
    bytes.writeUInt32LE(length - 8, 4)
    bytes.writeUInt32LE(1, 8)
    bytes.writeUInt32LE(16, 12)
    bytes.writeUInt32LE(1, 16)
    bytes.writeUInt32LE(1280, 20)
    bytes.writeUInt32LE(720, 24)
    bytes.writeUInt32LE(30, 28)
    bytes.writeUInt32LE(1, 32)
    bytes.writeUInt32LE(signature === 'BIK' ? 48 : 52, signature === 'BIK' ? 44 : 48)
    return bytes
}

const movieStatus = (bytes: Buffer) => {
    const resource = classifyResource('Movies/Intro.bk2', bytes)
    assert.ok(resource)
    return [resource.detectedFormat, resource.validationStatus]
}
const configStatus = (name: string, text: string | Buffer) => {
    const resource = classifyResource(name, Buffer.isBuffer(text) ? text : Buffer.from(text))
    assert.ok(resource)
    return [resource.detectedFormat, resource.validationStatus]
}

assert.equal(isResourceName('Content/Movies/StartUp_SBZ.bk2'), true)
assert.equal(isResourceName('UE4_LOGO.BK2'), true)
assert.equal(isResourceName('6/Engine.ini'), true)
assert.equal(isResourceName('Movies/StartUp_SBZ.bak2'), false, '.bak2 is not a movie alias')
assert.equal(classifyResource('Movies/StartUp_SBZ.bak2', bink('BIK')), null)
assert.equal(classifyResource('Mod_P.pak', bink('BIK')), null)

assert.deepEqual(movieStatus(bink('BIK')), ['bink1', 'valid'])
assert.deepEqual(movieStatus(bink('KB2')), ['bink2', 'valid'])
assert.deepEqual(
    movieStatus(Buffer.alloc(0)),
    ['empty', 'unsupported'],
    'a zero-byte deletion substitute is kept but is not a supported replacement'
)
assert.deepEqual(
    movieStatus(bink('BIK').subarray(0, 40)),
    ['bink1', 'invalid'],
    'a truncated header is invalid'
)
assert.deepEqual(
    movieStatus(bink('BIK').subarray(0, 60)),
    ['bink1', 'invalid'],
    'a payload shorter than its declared size is truncated'
)
{
    const noFrames = bink('BIK')
    noFrames.writeUInt32LE(0, 8)
    assert.deepEqual(movieStatus(noFrames), ['bink1', 'invalid'])
    const tooWide = bink('KB2')
    tooWide.writeUInt32LE(7681, 20)
    assert.deepEqual(movieStatus(tooWide), ['bink2', 'invalid'])
    const badRevision = bink('BIK')
    badRevision[3] = 0x21
    assert.deepEqual(movieStatus(badRevision), ['bink1', 'invalid'])
}
assert.deepEqual(
    movieStatus(Buffer.from('<!DOCTYPE html><html><body>Download</body></html>')),
    ['unrecognized', 'invalid'],
    'an HTML page served in place of a movie is recorded as invalid, not dropped'
)

const smallUi = '[/Script/Engine.UserInterfaceSettings]\r\nApplicationScale=0.6\r\n'
assert.deepEqual(configStatus('6/Engine.ini', smallUi), ['ascii', 'valid'])
assert.deepEqual(configStatus('Engine.ini', '[Core.System]\nPaths=\n'), ['ascii', 'valid'])
assert.deepEqual(
    configStatus(
        'Engine.ini',
        '[/Script/Engine.InputSettings]\r\nbEnableMouseSmoothing=False\r\nbEnableMouseSmoothing=False\r\n'
    ),
    ['ascii', 'unsupported'],
    'a repeated declaration is outside the scalar subset'
)
assert.deepEqual(
    configStatus('Engine.ini', '[S]\nKey=1\nkey=2\n'),
    ['ascii', 'unsupported'],
    'Unreal keys compare case-insensitively'
)
assert.deepEqual(configStatus('Engine.ini', '[S]\n+Paths=../Mods\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', '[S]\n!Paths=ClearArray\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', '[S]\nA=1\n[s]\nB=2\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', 'A=1\n[S]\nB=2\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', '[S]\r\nA=1\nB=2\r\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', '; comment only\n'), ['ascii', 'unsupported'])
assert.deepEqual(configStatus('Engine.ini', '[S\nA=1\n'), ['ascii', 'invalid'])
assert.deepEqual(configStatus('Engine.ini', '[S]\nA=\u00001\n'), ['ascii', 'invalid'])
assert.deepEqual(
    configStatus('ue4ss/UE4SS-settings.ini', '[General]\nEnableHotReloadSystem=1\n'),
    ['ascii', 'unsupported'],
    'a loader INI is never an installable Engine.ini preset'
)
assert.deepEqual(
    configStatus('Engine.ini', Buffer.alloc(0)),
    ['empty', 'unsupported'],
    'an empty config is kept with an explicit status'
)
assert.deepEqual(
    configStatus(
        'Engine.ini',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(smallUi)])
    ),
    ['utf8-bom', 'valid']
)
assert.deepEqual(
    configStatus(
        'Engine.ini',
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(smallUi, 'utf16le')])
    ),
    ['utf16le-bom', 'valid']
)
assert.deepEqual(configStatus('Engine.ini', Buffer.from([0xff, 0xfe, 0x5b, 0x00, 0x53])), [
    'utf16le-bom',
    'invalid',
])
assert.deepEqual(configStatus('Engine.ini', Buffer.from([0xfe, 0xff, 0x00, 0x5b])), [
    'utf16be-bom',
    'invalid',
])
{
    const bigEndian = Buffer.from(smallUi, 'utf16le').swap16()
    assert.deepEqual(
        configStatus('Engine.ini', Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])),
        ['utf16be-bom', 'valid']
    )
}
assert.deepEqual(
    configStatus('Engine.ini', '[S]\nName=Café\n'),
    ['utf8', 'unsupported'],
    'unmarked non-ASCII text is not a proven encoding'
)
assert.deepEqual(
    configStatus('Engine.ini', Buffer.from([0x5b, 0x53, 0x5d, 0x0a, 0x41, 0x3d, 0xc3])),
    ['utf8', 'invalid']
)

const names = { objectName: '43903_1_object.zip', sourceFilename: 'Skip Startup.zip' }

{
    const blank = bink('BIK')
    const zip = new AdmZip()
    for (const slot of [
        'ARC_25FPS.bk2',
        'cs_splash_505_igs_crimeboss.bk2',
        'logo_arc_4k_60fps.bk2',
        'UE4_Logo.bk2',
    ])
        zip.addFile(`CrimeBoss/Content/Movies/${slot}`, blank)
    zip.addFile('CrimeBoss/Content/Movies/UE4_Logo.bak2', blank)
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
    assert.equal(
        new Set(
            movies
                .filter((entry) => entry.resource?.validationStatus === 'valid')
                .map((entry) => entry.sha256)
        ).size,
        1
    )
    assert.deepEqual(movies.find((entry) => entry.entryName === 'broken/Broken.bk2')!.resource, {
        kind: 'movie',
        byteLength: 4,
        detectedFormat: 'bink1',
        validationStatus: 'invalid',
    })
    assert.deepEqual(
        entries.find((entry) => entry.entryName === 'empty/Engine.ini'),
        {
            sha256: sha256(Buffer.alloc(0)),
            entryName: 'empty/Engine.ini',
            resource: {
                kind: 'config',
                byteLength: 0,
                detectedFormat: 'empty',
                validationStatus: 'unsupported',
            },
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
        entries.map((entry) => [entry.entryName, entry.resource?.validationStatus]),
        [
            ['6/Engine.ini', 'valid'],
            ['7/Engine.ini', 'valid'],
            ['8/Engine.ini', 'valid'],
            ['9/Engine.ini', 'valid'],
        ],
        'each alternative is its own catalog entry'
    )
}

{
    const movie = bink('BIK')
    assert.deepEqual(
        extractContentEntries(movie, {
            objectName: '46731_1_object.bk2',
            sourceFilename: 'MCRTheBlackParade.bk2',
        }),
        [
            {
                sha256: sha256(movie),
                entryName: 'MCRTheBlackParade.bk2',
                resource: {
                    kind: 'movie',
                    byteLength: 64,
                    detectedFormat: 'bink1',
                    validationStatus: 'valid',
                },
            },
        ],
        'a loose movie is named by its hosted filename'
    )
    assert.equal(
        extractContentEntries(movie, { objectName: 'object.bk2', sourceFilename: null })[0]
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
    const html = Buffer.from('<!DOCTYPE html><title>Download</title>')
    assert.equal(
        extractContentEntries(html, { objectName: 'object', sourceFilename: 'Intro.bk2' })[0]
            .resource?.validationStatus,
        'invalid',
        'HTML published as a movie is collected as an invalid movie'
    )
    assert.deepEqual(
        extractContentEntries(html, { objectName: 'object', sourceFilename: 'Mod.pak' }),
        [{ sha256: sha256(html), entryName: 'object' }],
        'pak validation is not tightened'
    )
    assert.equal(
        extractContentEntries(html, {
            objectName: 'object',
            sourceFilename: null,
            advertisedKind: 'movie',
        })[0].resource?.validationStatus,
        'invalid',
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

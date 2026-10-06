// Classification restricts installation, while recognition keeps every published resource.
// test-unreal-resources.ts enforces extension handling and the supported scalar INI subset.

export interface ResourceMetadata {
    kind: 'movie' | 'config'
    byteLength: number
    detectedFormat: string
    validationStatus: 'valid' | 'unsupported' | 'invalid'
}

type Classification = Pick<ResourceMetadata, 'detectedFormat' | 'validationStatus'>

export function isResourceName(name: string): boolean {
    const lower = name.toLowerCase()
    return lower.endsWith('.bk2') || lower.endsWith('.ini')
}

export function classifyResource(
    entryName: string,
    bytes: Buffer,
    advertisedKind?: 'movie' | 'config'
): ResourceMetadata | null {
    const lower = entryName.toLowerCase()
    if (lower.endsWith('.bk2') || advertisedKind === 'movie')
        return { kind: 'movie', byteLength: bytes.length, ...classifyBink(bytes) }
    if (lower.endsWith('.ini') || advertisedKind === 'config')
        return { kind: 'config', byteLength: bytes.length, ...classifyConfig(entryName, bytes) }
    return null
}

// Limits from FFmpeg's Bink demuxer probe (libavformat/bink.c).
const binkMaxWidth = 7680
const binkMaxHeight = 4800
const binkHeaderBytes = 44

// Header and frame-index constraints follow FFmpeg's libavformat/bink.c.
function classifyBink(bytes: Buffer): Classification {
    if (bytes.length === 0) return { detectedFormat: 'empty', validationStatus: 'unsupported' }
    const signature = bytes.subarray(0, 3).toString('latin1')
    const format = signature === 'BIK' ? 'bink1' : signature === 'KB2' ? 'bink2' : null
    if (!format) return { detectedFormat: 'unrecognized', validationStatus: 'invalid' }
    const invalid: Classification = { detectedFormat: format, validationStatus: 'invalid' }
    if (bytes.length < binkHeaderBytes) return invalid
    const revision = String.fromCharCode(bytes[3])
    const revisions = format === 'bink1' ? 'bfghik' : 'adfghijk'
    if (!revisions.includes(revision)) return invalid
    const extra = format === 'bink1' ? revision === 'k' : 'ijk'.includes(revision)
    const declaredLength = bytes.readUInt32LE(4) + 8
    const frames = bytes.readUInt32LE(8)
    const largestFrame = bytes.readUInt32LE(12)
    const width = bytes.readUInt32LE(20)
    const height = bytes.readUInt32LE(24)
    const tracks = bytes.readUInt32LE(40)
    if (
        declaredLength !== bytes.length ||
        frames === 0 ||
        frames > 1_000_000 ||
        largestFrame > declaredLength ||
        width === 0 ||
        width > binkMaxWidth ||
        height === 0 ||
        height > binkMaxHeight ||
        bytes.readUInt32LE(28) === 0 ||
        bytes.readUInt32LE(32) === 0 ||
        tracks > 256
    )
        return invalid
    const indexStart = 44 + (extra ? 4 : 0) + tracks * 12
    const indexEnd = indexStart + frames * 4
    if (indexEnd >= declaredLength) return invalid
    let position = (bytes.readUInt32LE(indexStart) & 0xfffffffe) >>> 0
    if (position < indexEnd) return invalid
    for (let frame = 0; frame < frames; frame++) {
        const next =
            frame + 1 === frames
                ? declaredLength
                : (bytes.readUInt32LE(indexStart + (frame + 1) * 4) & 0xfffffffe) >>> 0
        if (next <= position || next > declaredLength) return invalid
        position = next
    }
    return { detectedFormat: format, validationStatus: 'valid' }
}

interface DecodedConfig {
    detectedFormat: string
    text: string | null
}

// Unmarked non-ASCII bytes do not prove the author's intended encoding.
function decodeConfig(bytes: Buffer): DecodedConfig {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return { detectedFormat: 'utf8-bom', text: strictDecode('utf-8', bytes.subarray(3)) }
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return { detectedFormat: 'utf16le-bom', text: strictDecode('utf-16le', bytes.subarray(2)) }
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return { detectedFormat: 'utf16be-bom', text: strictDecode('utf-16be', bytes.subarray(2)) }
    if (bytes.every((byte) => byte < 0x80))
        return { detectedFormat: 'ascii', text: bytes.toString('latin1') }
    return { detectedFormat: 'utf8', text: strictDecode('utf-8', bytes) }
}

function strictDecode(encoding: 'utf-8' | 'utf-16le' | 'utf-16be', bytes: Buffer): string | null {
    if (encoding !== 'utf-8' && bytes.length % 2 !== 0) return null
    try {
        return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
        // A decode failure is the classification itself: the bytes are not that encoding.
        return null
    }
}

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

// Unreal layers repeated declarations and array operators, so reducing them to a map would
// change their meaning. Only reversible scalar Engine.ini assignments are presets.
function classifyConfig(entryName: string, bytes: Buffer): Classification {
    if (bytes.length === 0) return { detectedFormat: 'empty', validationStatus: 'unsupported' }
    const { detectedFormat, text } = decodeConfig(bytes)
    if (text === null || controlCharacters.test(text))
        return { detectedFormat, validationStatus: 'invalid' }

    const structure = configStructure(text)
    if (structure === 'invalid') return { detectedFormat, validationStatus: 'invalid' }
    const isEngineIni = entryName.split('/').pop()?.toLowerCase() === 'engine.ini'
    const encodingKnown = detectedFormat !== 'utf8'
    return {
        detectedFormat,
        validationStatus:
            structure === 'scalar' && isEngineIni && encodingKnown ? 'valid' : 'unsupported',
    }
}

function hasMixedLineEndings(text: string): boolean {
    const crlf = text.match(/\r\n/g)?.length ?? 0
    const lf = (text.match(/\n/g)?.length ?? 0) - crlf
    const cr = (text.match(/\r/g)?.length ?? 0) - crlf
    return [crlf, lf, cr].filter((count) => count > 0).length > 1
}

function configStructure(text: string): 'scalar' | 'unsupported' | 'invalid' {
    let structure: 'scalar' | 'unsupported' = hasMixedLineEndings(text) ? 'unsupported' : 'scalar'
    const sections = new Set<string>()
    let keys: Set<string> | null = null
    let declarations = 0
    for (const line of text.split(/\r\n|\n|\r/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(';')) continue
        if (trimmed.startsWith('[')) {
            const section = trimmed.endsWith(']') ? trimmed.slice(1, -1).trim().toLowerCase() : ''
            if (!section) return 'invalid'
            if (sections.has(section)) structure = 'unsupported'
            sections.add(section)
            keys = new Set()
            continue
        }
        const separator = trimmed.indexOf('=')
        const key = separator > 0 ? trimmed.slice(0, separator).trim().toLowerCase() : ''
        if (!keys || !key || '+-.!'.includes(key[0]) || keys.has(key)) {
            structure = 'unsupported'
            continue
        }
        keys.add(key)
        declarations++
    }
    return declarations === 0 ? 'unsupported' : structure
}

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import type { ContentEntry } from './content-archive.js'

interface CentralDirectoryEntry {
    name: string
    localOffset: number
    compressedSize: number
    compressionMethod: number
}

class MissingArchiveError extends Error {}
class BlockedUrlError extends Error {}

const maxFullArchiveBytes = 50 * 1024 * 1024
const maxRedirects = 5
// Read once at load so only the environment can set it, and it lifts the address check for
// loopback alone: test-marker-archive.ts serves its fixtures from 127.0.0.1, while every other
// blocked range stays refused in the same process the tests assert against. Nothing in CI or
// the workflow sets this.
const allowLoopbackFetch = process.env.MODREX_INDEX_ALLOW_LOOPBACK_FETCH === '1'
const pdmodPassword = `0$45'5))66S2ixF51a<6}L2UK`
const pdmodHashlistPath = join(import.meta.dirname, '..', 'pdmod_hashlist.txt')

export function chooseMarker(paths: string[]): string | null {
    const files = paths.filter((path) => !path.endsWith('/'))
    if (files.length === 0) return null

    const depth = (path: string) => path.split('/').length - 1
    const firstMatch = (names: string[]): string | undefined =>
        files.find((path) => {
            const normalized = path.toLowerCase()
            return (
                names.some((name) => normalized === name || normalized.endsWith(`/${name}`)) &&
                depth(path) <= 1
            )
        })

    const marker = firstMatch(['mod.txt']) ?? firstMatch(['base.lua']) ?? firstMatch(['main.xml'])
    if (marker) return marker

    const raidMarker = firstMatch(['supermod.xml']) ?? firstMatch(['mod.xml'])
    if (raidMarker) return raidMarker

    // No marker, so the pick is positional, and it has to land on the same file modrex-main
    // picks from the installed folder or the mod can never be identified by hash. Comparing
    // UTF-8 bytes is the one ordering both languages express identically; localeCompare orders
    // punctuation by ICU rules that Rust has no equivalent for. See marker-contract.json.
    const roots = [...new Set(files.map((path) => path.split('/')[0]))]
    const prefix = roots.length === 1 && roots[0] !== '' ? `${roots[0]}/` : ''
    return (
        files
            .filter((path) => path.startsWith(prefix) && !isRegeneratedByTheOs(path))
            .map((path) => ({ path, relative: path.slice(prefix.length) }))
            .sort((left, right) => compareBytes(left.relative, right.relative))[0]?.path ?? null
    )
}

// Explorer and Finder write these into a folder on their own, and they sort early enough to win
// the positional pick. The copy on a user's disk is rewritten locally, so a fingerprint taken
// from one stops matching the archive it came from.
function isRegeneratedByTheOs(path: string): boolean {
    const name = path.split('/').pop()?.toLowerCase()
    return name === 'thumbs.db' || name === 'desktop.ini' || name === '.ds_store'
}

function compareBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

// Addresses no mod download can legitimately live behind, and that a URL on a mod page can
// otherwise aim this worker at: loopback, the RFC1918 and unique-local ranges, and link-local
// including the cloud metadata address.
// The URL parser rewrites an IPv4-mapped IPv6 literal into hex groups, so ::ffff:127.0.0.1
// arrives as ::ffff:7f00:1 and only reads as loopback once it is back in dotted form.
function mappedIpv4(value: string): string | null {
    if (!value.startsWith('::ffff:')) return null
    const rest = value.slice('::ffff:'.length)
    if (rest.includes('.')) return rest
    const [high, low] = rest.split(':').map((group) => parseInt(group, 16))
    if (!Number.isInteger(high) || !Number.isInteger(low)) return null
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function isLoopbackAddress(host: string): boolean {
    const value = host.toLowerCase().replace(/^\[|]$/g, '')
    const mapped = mappedIpv4(value)
    if (mapped) return isLoopbackAddress(mapped)
    return value === 'localhost' || value === '::1' || value.startsWith('127.')
}

function isBlockedAddress(host: string): boolean {
    const value = host.toLowerCase().replace(/^\[|]$/g, '')
    if (value === 'localhost' || value.endsWith('.localhost')) return true

    if (isIP(value) === 6) {
        const mapped = mappedIpv4(value)
        if (mapped) return isBlockedAddress(mapped)
        if (value === '::1' || value === '::') return true
        const group = parseInt(value.split(':')[0] || '0', 16)
        // fc00::/7 unique-local and fe80::/10 link-local.
        return (group & 0xfe00) === 0xfc00 || (group & 0xffc0) === 0xfe80
    }
    if (isIP(value) !== 4) return false

    const [a, b] = value.split('.').map(Number)
    return (
        a === 127 ||
        a === 0 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
    )
}

// A link URL comes from a mod page, so it is attacker-chosen, and this worker runs in CI next
// to the index database and R2 credentials. It reads the response but never stores or echoes
// it beyond a SHA256 of ZIP-structured bytes, so the realistic risk is an outbound GET at an
// address the runner can reach and nothing else. Both the URL and every redirect hop are
// checked, and a name is resolved once before use. What this does not stop is a name that
// resolves to a public address here and a private one when fetch resolves it again; pinning
// the resolved address would need a custom dispatcher, which is only worth it if this ever
// runs on a self-hosted runner inside a private network.
export async function assertFetchableUrl(url: string): Promise<void> {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') {
        throw new BlockedUrlError(`unsupported scheme ${protocol}`)
    }
    if (allowLoopbackFetch && isLoopbackAddress(hostname)) return
    if (isBlockedAddress(hostname)) throw new BlockedUrlError(`blocked host ${hostname}`)
    if (isIP(hostname.replace(/^\[|]$/g, '')) !== 0) return

    const resolved = await lookup(hostname).catch(() => null)
    if (resolved && isBlockedAddress(resolved.address)) {
        throw new BlockedUrlError(`${hostname} resolves to ${resolved.address}`)
    }
}

// Redirects are followed here rather than by fetch so every hop passes the check above.
async function request(url: string, init: RequestInit): Promise<Response> {
    let target = url
    for (let hop = 0; ; hop++) {
        await assertFetchableUrl(target)
        const response = await fetch(target, {
            ...init,
            headers: { 'User-Agent': 'modrex-index-builder', ...init.headers },
            redirect: 'manual',
        })
        const location = response.headers.get('location')
        if (response.status < 300 || response.status > 399 || !location) return response
        if (hop === maxRedirects) throw new Error('too many redirects')
        await response.body?.cancel()
        target = new URL(location, target).toString()
    }
}

async function contentLength(url: string): Promise<number | null> {
    const response = await request(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return null
    const length = Number(response.headers.get('content-length'))
    return Number.isSafeInteger(length) && length > 0 ? length : null
}

async function rangeGet(url: string, start: number, end: number): Promise<Buffer> {
    const response = await request(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(60_000),
    })
    if (response.status === 404) throw new MissingArchiveError()
    if (response.status !== 200 && response.status !== 206) {
        throw new Error(`range request returned ${response.status}`)
    }
    return Buffer.from(await response.arrayBuffer())
}

function findEocd(buffer: Buffer): { offset: number; size: number } | null {
    for (let position = buffer.length - 22; position >= 0; position--) {
        if (buffer.readUInt32LE(position) !== 0x06054b50) continue
        const size = buffer.readUInt32LE(position + 12)
        const offset = buffer.readUInt32LE(position + 16)
        if (size !== 0xffffffff && offset !== 0xffffffff) return { offset, size }
    }
    return null
}

function parseCentralDirectory(buffer: Buffer): CentralDirectoryEntry[] {
    const entries: CentralDirectoryEntry[] = []
    for (let position = 0; position + 46 <= buffer.length;) {
        if (buffer.readUInt32LE(position) !== 0x02014b50) break
        const fileNameLength = buffer.readUInt16LE(position + 28)
        const extraLength = buffer.readUInt16LE(position + 30)
        const commentLength = buffer.readUInt16LE(position + 32)
        entries.push({
            name: buffer.subarray(position + 46, position + 46 + fileNameLength).toString('utf8'),
            compressionMethod: buffer.readUInt16LE(position + 10),
            compressedSize: buffer.readUInt32LE(position + 20),
            localOffset: buffer.readUInt32LE(position + 42),
        })
        position += 46 + fileNameLength + extraLength + commentLength
    }
    return entries
}

function inflateEntry(compressionMethod: number, compressed: Buffer): Buffer | null {
    if (compressionMethod === 0) return compressed
    if (compressionMethod !== 8) return null
    try {
        // Deflate reaches about 1000x on repetitive data, so without a ceiling a crafted
        // entry turns a few hundred kilobytes of download into tens of gigabytes of heap and
        // kills the job. The archive cap is the ceiling: every real marker file is far under
        // it, and anything above it was not going to be indexed whole either.
        return inflateRawSync(compressed, { maxOutputLength: maxFullArchiveBytes })
    } catch {
        return null
    }
}

// Downloads a whole archive, giving up as soon as it passes the size cap rather than after
// the fact, since a link points at a host ModWorkshop does not control and its length is not
// always declared up front.
async function downloadWithinCap(url: string): Promise<Buffer | null> {
    const response = await request(url, { signal: AbortSignal.timeout(120_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`download returned ${response.status}`)
    if (!response.body) return null

    const declared = Number(response.headers.get('content-length'))
    if (Number.isSafeInteger(declared) && declared > maxFullArchiveBytes) {
        await response.body.cancel()
        return null
    }

    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of response.body) {
        received += chunk.length
        // Leaving the loop early cancels the body through the iterator's own cleanup.
        if (received > maxFullArchiveBytes) return null
        chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
}

function markerFromBuffer(archive: Buffer): ContentEntry | null {
    const eocd = findEocd(archive)
    if (!eocd) return null

    const entries = parseCentralDirectory(archive.subarray(eocd.offset, eocd.offset + eocd.size))
    const name = chooseMarker(entries.map((entry) => entry.name))
    const entry = name ? entries.find((candidate) => candidate.name === name) : undefined
    if (!entry || entry.compressedSize === 0) return null

    const header = archive.subarray(entry.localOffset, entry.localOffset + 30)
    if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) return null
    const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const content = inflateEntry(
        entry.compressionMethod,
        archive.subarray(dataStart, dataStart + entry.compressedSize)
    )
    if (!content) return null

    return { sha256: createHash('sha256').update(content).digest('hex'), entryName: entry.name }
}

async function markerFromZip(url: string, size: number | null): Promise<ContentEntry | null> {
    try {
        const archiveSize = size ?? (await contentLength(url))
        // Hosts that build the archive per request, GitHub's source-archive endpoint being the
        // common one, declare no length and serve no byte ranges, so the ranged reads below
        // have nothing to aim at. Reading the whole archive is the only way to its marker.
        if (archiveSize === null) {
            const archive = await downloadWithinCap(url)
            return archive ? markerFromBuffer(archive) : null
        }
        if (archiveSize < 22) return null

        const tail = await rangeGet(url, Math.max(0, archiveSize - 65_557), archiveSize - 1)
        const eocd = findEocd(tail)
        if (!eocd) return null

        const entries = parseCentralDirectory(
            await rangeGet(url, eocd.offset, eocd.offset + eocd.size - 1)
        )
        const name = chooseMarker(entries.map((entry) => entry.name))
        const entry = name ? entries.find((candidate) => candidate.name === name) : undefined
        if (!entry || entry.compressedSize === 0) return null

        const header = await rangeGet(url, entry.localOffset, entry.localOffset + 29)
        if (header.readUInt32LE(0) !== 0x04034b50) return null
        const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
        const compressed = await rangeGet(url, dataStart, dataStart + entry.compressedSize - 1)

        const content = inflateEntry(entry.compressionMethod, compressed)
        if (!content) return null

        return { sha256: createHash('sha256').update(content).digest('hex'), entryName: entry.name }
    } catch (error) {
        if (error instanceof MissingArchiveError) return null
        if (error instanceof Error && error.message === 'range request returned 416') {
            return null
        }
        throw error
    }
}

async function markerFromFullArchive(
    url: string,
    extension: '.7z' | '.rar'
): Promise<ContentEntry | null> {
    const response = await request(url, { signal: AbortSignal.timeout(120_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`download returned ${response.status}`)

    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'modrex-marker-'))
    try {
        const archive = join(temporaryDirectory, `archive${extension}`)
        const output = join(temporaryDirectory, 'out')
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
        try {
            execFileSync('7z', ['x', archive, `-o${output}`, '-y'], { stdio: 'ignore' })
        } catch {
            // An archive this runner cannot open yields nothing, which is indistinguishable
            // from an archive holding nothing, and the listing is then recorded as checked.
            // Naming it keeps a missing codec visible in the run log: p7zip-full reads RAR5
            // and needs p7zip-rar for RAR4.
            console.warn(`7z could not open ${extension} archive: ${url}`)
            return null
        }
        if (!existsSync(output)) return null
        const paths = (readdirSync(output, { recursive: true }) as string[])
            .filter((path) => statSync(join(output, path)).isFile())
            .map((path) => path.replace(/\\/g, '/'))
        const marker = chooseMarker(paths)
        if (!marker) return null
        const content = readFileSync(join(output, marker))
        return { sha256: createHash('sha256').update(content).digest('hex'), entryName: marker }
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

export async function extractMarkerEntry(
    url: string,
    knownSize: number | null
): Promise<ContentEntry | null> {
    try {
        const extension = new URL(url).pathname.toLowerCase()
        if (extension.endsWith('.7z') || extension.endsWith('.rar')) {
            const size = knownSize ?? (await contentLength(url))
            if (size === null || size > maxFullArchiveBytes) return null
            return await markerFromFullArchive(url, extension.endsWith('.rar') ? '.rar' : '.7z')
        }
        return await markerFromZip(url, knownSize)
    } catch (error) {
        // A blocked URL yields nothing, the same as a dead link. Rethrowing would fail the
        // whole run over one mod page, and the caller would keep retrying a URL that can
        // never be fetched.
        if (error instanceof BlockedUrlError) return null
        throw error
    }
}

function mix64(a: bigint, b: bigint, c: bigint): [bigint, bigint, bigint] {
    const mask = 0xffffffffffffffffn
    a = ((a - b - c) ^ (c >> 43n)) & mask
    b = ((b - c - a) ^ (a << 9n)) & mask
    c = ((c - a - b) ^ (b >> 8n)) & mask
    a = ((a - b - c) ^ (c >> 38n)) & mask
    b = ((b - c - a) ^ (a << 23n)) & mask
    c = ((c - a - b) ^ (b >> 5n)) & mask
    a = ((a - b - c) ^ (c >> 35n)) & mask
    b = ((b - c - a) ^ (a << 49n)) & mask
    c = ((c - a - b) ^ (b >> 11n)) & mask
    a = ((a - b - c) ^ (c >> 12n)) & mask
    b = ((b - c - a) ^ (a << 18n)) & mask
    c = ((c - a - b) ^ (b >> 22n)) & mask
    return [a, b, c]
}

function hash64(value: string): bigint {
    const input = Buffer.from(value, 'utf8')
    const mask = 0xffffffffffffffffn
    let a = 0n
    let b = 0n
    let c = 0x9e3779b97f4a7c13n
    let position = 0
    while (position + 24 <= input.length) {
        a = (a + input.readBigUInt64LE(position)) & mask
        b = (b + input.readBigUInt64LE(position + 8)) & mask
        c = (c + input.readBigUInt64LE(position + 16)) & mask
        ;[a, b, c] = mix64(a, b, c)
        position += 24
    }
    const byte = (offset: number): bigint =>
        position + offset < input.length ? BigInt(input[position + offset]) : 0n
    c = (c + BigInt(input.length)) & mask
    a =
        (a +
            byte(0) +
            (byte(1) << 8n) +
            (byte(2) << 16n) +
            (byte(3) << 24n) +
            (byte(4) << 32n) +
            (byte(5) << 40n) +
            (byte(6) << 48n) +
            (byte(7) << 56n)) &
        mask
    b =
        (b +
            byte(8) +
            (byte(9) << 8n) +
            (byte(10) << 16n) +
            (byte(11) << 24n) +
            (byte(12) << 32n) +
            (byte(13) << 40n) +
            (byte(14) << 48n) +
            (byte(15) << 56n)) &
        mask
    c =
        (c +
            byte(16) +
            (byte(17) << 8n) +
            (byte(18) << 16n) +
            (byte(19) << 24n) +
            (byte(20) << 32n) +
            (byte(21) << 40n) +
            (byte(22) << 56n)) &
        mask
    ;[, , c] = mix64(a, b, c)
    return c
}

let pdmodHashlist: Map<bigint, string> | undefined

function resolvedPdmodHashlist(): Map<bigint, string> {
    if (pdmodHashlist) return pdmodHashlist
    pdmodHashlist = new Map()
    for (const line of readFileSync(pdmodHashlistPath, 'utf8').split('\n')) {
        const value = line.trim()
        if (value) pdmodHashlist.set(hash64(value), value)
    }
    return pdmodHashlist
}

interface PdmodItem {
    BundlePath: string
    BundleExtension: string
    ReplacementFile: string
}

export async function extractPdmodEntry(url: string): Promise<ContentEntry | null> {
    const response = await request(url, { signal: AbortSignal.timeout(120_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`download returned ${response.status}`)
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'modrex-pdmod-'))
    try {
        const archive = join(temporaryDirectory, 'archive.pdmod')
        const output = join(temporaryDirectory, 'out')
        mkdirSync(output)
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
        try {
            execFileSync('7z', ['x', archive, `-p${pdmodPassword}`, `-o${output}`, '-y'], {
                stdio: 'ignore',
            })
        } catch {
            return null
        }
        const manifestPath = join(output, 'pdmod.json')
        if (!existsSync(manifestPath)) return null
        const manifest = JSON.parse(
            readFileSync(manifestPath, 'utf8').replace(
                /("BundlePath"|"BundleExtension"):\s*(\d+)/g,
                (_match, key: string, value: string) => `${key}: ${JSON.stringify(value)}`
            )
        ) as { ItemQueue: PdmodItem[] }
        const hashlist = resolvedPdmodHashlist()
        const replacements = manifest.ItemQueue.flatMap((item) => {
            const path = hashlist.get(BigInt(item.BundlePath))
            const extension = hashlist.get(BigInt(item.BundleExtension))
            return path && extension
                ? [{ path: `${path}.${extension}`, replacement: item.ReplacementFile }]
                : []
        }).sort((left, right) => left.path.localeCompare(right.path))
        const first = replacements[0]
        if (!first) return null
        const replacementPath = join(output, first.replacement)
        if (!existsSync(replacementPath)) return null
        return {
            sha256: createHash('sha256').update(readFileSync(replacementPath)).digest('hex'),
            entryName: first.path,
        }
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

import AdmZip from 'adm-zip'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    existsSync,
    lstatSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

import { UnusableDownloadError } from './marker-archive.js'
import { classifyResource, isResourceName, type ResourceMetadata } from './unreal-resource.js'

export interface ContentEntry {
    sha256: string
    entryName: string
    // Set for movie and config resources, which never enter the compatibility files projection.
    resource?: ResourceMetadata
}

// A loose download has no entry path of its own. A loose pak is named by its storage object,
// while a loose resource takes the hosted filename, since the storage object name says nothing
// about which movie or config slot it fills.
export interface LooseDownloadNames {
    objectName: string
    sourceFilename: string | null
    advertisedKind?: 'movie' | 'config'
}

const contentExtensions = ['.pak', '.ucas', '.utoc', '.lua']
const resourceArchiveLimit = 1024 * 1024 * 1024

function resourceLimit(name: string, kind?: 'movie' | 'config'): number {
    return kind === 'config' || name.toLowerCase().endsWith('.ini')
        ? 1024 * 1024
        : 512 * 1024 * 1024
}

function checkResourceSize(
    name: string,
    size: number,
    total: number,
    kind?: 'movie' | 'config'
): number {
    if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > resourceLimit(name, kind) ||
        total + size > resourceArchiveLimit
    )
        throw new UnusableDownloadError(`Resource ${name} exceeds the extraction limit`)
    return total + size
}

function isUnsafeResourcePath(name: string): boolean {
    return /^[\\/]|^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..')
}

function resourceMembers(archive: string): { name: string; size: number }[] {
    let listing: string
    try {
        listing = execFileSync('7z', ['l', '-slt', '-ba', archive], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        })
    } catch (error) {
        throw new UnusableDownloadError(`Resource archive could not be listed: ${error}`)
    }
    const members: { name: string; size: number }[] = []
    let total = 0
    for (const block of listing.split(/\r?\n\r?\n/)) {
        const fields = new Map(
            block.split(/\r?\n/).map((line) => {
                const separator = line.indexOf(' = ')
                return [line.slice(0, separator), line.slice(separator + 3)]
            })
        )
        const name = fields.get('Path')
        if (!name || !isResourceName(name) || fields.get('Folder') === '+') continue
        if (
            isUnsafeResourcePath(name) ||
            fields.get('Symbolic Link') ||
            fields.get('Hard Link') ||
            /(?:^|\s)l[rwx-]{9}/.test(fields.get('Attributes') ?? '')
        )
            throw new UnusableDownloadError(`Resource ${name} has an unsafe archive path`)
        const size = Number(fields.get('Size'))
        total = checkResourceSize(name, size, total)
        members.push({ name, size })
        if (members.length > 128)
            throw new UnusableDownloadError('Archive contains more than 128 resource entries')
    }
    return members
}

function matchesContentExtension(name: string): boolean {
    const lower = name.toLowerCase()
    return contentExtensions.some((extension) => lower.endsWith(extension))
}

function isCollected(name: string): boolean {
    return matchesContentExtension(name) || isResourceName(name)
}

function detectFormat(buffer: Buffer): 'zip' | '7z' | 'rar' | 'pak' {
    if (
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04
    ) {
        return 'zip'
    }
    if (
        buffer.length >= 6 &&
        buffer[0] === 0x37 &&
        buffer[1] === 0x7a &&
        buffer[2] === 0xbc &&
        buffer[3] === 0xaf &&
        buffer[4] === 0x27 &&
        buffer[5] === 0x1c
    ) {
        return '7z'
    }
    if (
        buffer.length >= 6 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x61 &&
        buffer[2] === 0x72 &&
        buffer[3] === 0x21 &&
        buffer[4] === 0x1a &&
        buffer[5] === 0x07
    ) {
        return 'rar'
    }
    return 'pak'
}

function hashContent(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex')
}

function contentEntry(
    entryName: string,
    content: Buffer,
    advertisedKind?: 'movie' | 'config'
): ContentEntry {
    const name = entryName.replace(/\\/g, '/')
    const resource = classifyResource(name, content, advertisedKind)
    const entry = { sha256: hashContent(content), entryName: resource ? name : entryName }
    return resource ? { ...entry, resource } : entry
}

function extractWith7z(buffer: Buffer, extension: '.7z' | '.rar'): ContentEntry[] {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'modrex-idx-'))
    try {
        const archive = join(temporaryDirectory, `archive${extension}`)
        const outputDirectory = join(temporaryDirectory, 'out')
        writeFileSync(archive, buffer)
        const started = Date.now()
        const resources = resourceMembers(archive).map(({ name, size }) => {
            const remaining = 60_000 - (Date.now() - started)
            if (remaining <= 0)
                throw new UnusableDownloadError('Resource extraction exceeded one minute')
            let bytes: Buffer
            try {
                bytes = execFileSync('7z', ['e', '-so', '-spd', archive, name], {
                    timeout: remaining,
                    maxBuffer: resourceLimit(name) + 1,
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
            } catch (error) {
                throw new UnusableDownloadError(`Resource ${name} could not be extracted: ${error}`)
            }
            if (bytes.length !== size)
                throw new UnusableDownloadError(
                    `Resource ${name} has an inconsistent extracted size`
                )
            return contentEntry(name, bytes)
        })
        // RAR wildcard extraction differs from 7z, so its package entries are filtered here.
        const masks =
            extension === '.7z' ? contentExtensions.map((item) => `*${item}`).concat('-r') : []
        run7z(
            ['x', archive, `-o${outputDirectory}`, ...masks, '-x!*.bk2', '-x!*.ini', '-ssc-', '-y'],
            extension
        )
        // 7z creates no output directory when nothing was extracted.
        if (!existsSync(outputDirectory)) return resources
        const contents = (readdirSync(outputDirectory, { recursive: true }) as string[])
            .filter((entryName) => {
                return (
                    matchesContentExtension(entryName) &&
                    lstatSync(join(outputDirectory, entryName)).isFile()
                )
            })
            .map((entryName) =>
                contentEntry(
                    entryName.replace(/\\/g, '/'),
                    readFileSync(join(outputDirectory, entryName))
                )
            )
        return [...contents, ...resources]
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

// An archive this runner cannot open has not been shown to hold nothing, so it settles as
// unusable with the reason rather than as a successful empty extraction.
function run7z(args: string[], extension: '.7z' | '.rar'): void {
    try {
        execFileSync('7z', args, { stdio: 'ignore' })
    } catch (error) {
        throw new UnusableDownloadError(`7z could not extract ${extension} archive: ${error}`)
    }
}

function extractZip(buffer: Buffer): ContentEntry[] {
    let entries: AdmZip.IZipEntry[]
    try {
        entries = new AdmZip(buffer).getEntries()
    } catch (error) {
        throw new UnusableDownloadError(`zip archive could not be read: ${error}`)
    }
    let resourceBytes = 0
    return entries
        .filter((entry) => !entry.isDirectory && isCollected(entry.entryName))
        .map((entry) => {
            if (isResourceName(entry.entryName)) {
                if (isUnsafeResourcePath(entry.entryName))
                    throw new UnusableDownloadError(
                        `Resource ${entry.entryName} has an unsafe archive path`
                    )
                resourceBytes = checkResourceSize(entry.entryName, entry.header.size, resourceBytes)
            }
            let data: Buffer
            try {
                if (!isResourceName(entry.entryName)) {
                    data = entry.getData()
                } else {
                    if ((entry.header.flags & 1) !== 0) throw new Error('Encrypted resource entry')
                    const compressed = entry.getCompressedData()
                    if (entry.header.method === 0) data = compressed
                    else if (entry.header.method === 8)
                        data = inflateRawSync(compressed, {
                            maxOutputLength: resourceLimit(entry.entryName),
                        })
                    else throw new Error('Unsupported resource compression method')
                    if (crc32(data) !== entry.header.crc)
                        throw new Error('Resource CRC does not match')
                }
            } catch (error) {
                throw new UnusableDownloadError(
                    `zip entry ${entry.entryName} could not be read: ${error}`
                )
            }
            if (isResourceName(entry.entryName) && data.length !== entry.header.size)
                throw new UnusableDownloadError(
                    `Resource ${entry.entryName} has an inconsistent extracted size`
                )
            return contentEntry(entry.entryName, data)
        })
}

export function extractContentEntries(buffer: Buffer, names: LooseDownloadNames): ContentEntry[] {
    const format = detectFormat(buffer)
    if (format === 'zip') return extractZip(buffer)
    if (format === '7z') return extractWith7z(buffer, '.7z')
    if (format === 'rar') return extractWith7z(buffer, '.rar')

    const looseName =
        names.sourceFilename && isResourceName(names.sourceFilename)
            ? names.sourceFilename
            : names.objectName
    if (isResourceName(looseName) || names.advertisedKind) {
        checkResourceSize(looseName, buffer.length, 0, names.advertisedKind)
        return [contentEntry(looseName, buffer, names.advertisedKind)]
    }
    return [{ sha256: hashContent(buffer), entryName: names.objectName }]
}

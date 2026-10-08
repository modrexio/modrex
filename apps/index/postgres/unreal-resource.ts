// Recognition keeps every published movie and config, including empty or malformed bytes. The
// desktop validates bytes before installing. test-unreal-resources.ts enforces kind handling.

export interface ResourceMetadata {
    kind: 'movie' | 'config'
    byteLength: number
}

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
        return { kind: 'movie', byteLength: bytes.length }
    if (lower.endsWith('.ini') || advertisedKind === 'config')
        return { kind: 'config', byteLength: bytes.length }
    return null
}

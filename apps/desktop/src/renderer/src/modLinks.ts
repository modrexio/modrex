/**
 * Parses a ModWorkshop URL or path and extracts the numerical mod ID if present.
 *
 * Supported formats:
 * - https://modworkshop.net/mod/12345
 * - http://modworkshop.net/mod/12345
 * - https://www.modworkshop.net/mod/12345
 * - https://modworkshop.net/mod/12345/
 * - https://modworkshop.net/mod/12345?tab=images
 * - https://modworkshop.net/mod/12345#description
 * - https://modworkshop.net/mod/12345/comments
 *
 * Returns `null` for non-mod URLs, non-ModWorkshop URLs, or malformed inputs.
 */
export function parseModworkshopModId(url: string | null | undefined): number | null {
    if (!url) return null
    const trimmed = url.trim()
    if (!trimmed) return null

    if (!/^https?:\/\//i.test(trimmed)) return null

    try {
        const parsed = new URL(trimmed)
        const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase()
        if (hostname !== 'modworkshop.net') return null

        const match = parsed.pathname.match(/^\/mod\/(\d+)(?:\/|$)/i)
        if (!match) return null

        const id = parseInt(match[1]!, 10)
        return Number.isSafeInteger(id) && id > 0 ? id : null
    } catch {
        return null
    }
}

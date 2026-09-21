export interface ModListing {
    id: number
    name: string
    has_download: boolean
    bumped_at: string
    updated_at: string
    download_id: number | null
    download_type: string | null
}

export interface ModFile {
    id: number
    file: string
    size: number
    type: string
    version: string
    download_url: string
}

export interface ModLink {
    id: number
    url: string
    version: string | null
}
export interface Page<T> {
    data: T[]
    meta: { current_page: number; last_page: number }
}
export type VersionResult =
    | { status: 'known'; version: string }
    | { status: 'missing' }
    | { status: 'failed'; error: string }

export class ModWorkshopApiError extends Error {
    constructor(
        readonly status: number,
        readonly path: string
    ) {
        super(`ModWorkshop API ${status}: ${path}`)
    }
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected ModWorkshop object')
    return value as Record<string, unknown>
}
function string(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new Error(`Invalid ModWorkshop ${field}`)
    return value
}
function id(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        throw new Error('Invalid ModWorkshop ID')
    return value
}
function date(value: unknown, field: string): string {
    const text = string(value, field)
    if (!Number.isFinite(Date.parse(text))) throw new Error(`Invalid ModWorkshop ${field}`)
    return text
}

export function parseListing(value: unknown): ModListing {
    const row = object(value)
    if (typeof row.has_download !== 'boolean') throw new Error('Invalid ModWorkshop has_download')
    return {
        id: id(row.id),
        name: string(row.name, 'name'),
        has_download: row.has_download,
        bumped_at: date(row.bumped_at, 'bumped_at'),
        updated_at: date(row.updated_at, 'updated_at'),
        download_id: row.download_id === null ? null : id(row.download_id),
        download_type:
            row.download_type === null ? null : string(row.download_type, 'download_type'),
    }
}

export function parseFile(value: unknown): ModFile {
    const row = object(value)
    if (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0)
        throw new Error('Invalid ModWorkshop file size')
    return {
        id: id(row.id),
        file: string(row.file, 'file'),
        size: row.size,
        type: row.type === null ? '' : string(row.type, 'type'),
        version: row.version === null ? '' : string(row.version, 'version'),
        download_url: string(row.download_url, 'download_url'),
    }
}

export function parseLink(value: unknown): ModLink {
    const row = object(value)
    return {
        id: id(row.id),
        url: string(row.url, 'url'),
        version:
            row.version === null || row.version === undefined
                ? null
                : string(row.version, 'version'),
    }
}

export function parseVersions(value: unknown, ids: readonly number[]): Map<number, VersionResult> {
    const row = Array.isArray(value) && value.length === 0 ? {} : object(value)
    const requested = new Set(ids)
    for (const [key, version] of Object.entries(row)) {
        if (!/^[1-9]\d*$/.test(key) || !requested.has(Number(key)))
            throw new Error('Unexpected ModWorkshop version ID')
        string(version, 'version')
    }
    return new Map(
        ids.map((id) => [
            id,
            Object.hasOwn(row, String(id))
                ? { status: 'known', version: string(row[id], 'version') }
                : { status: 'missing' },
        ])
    )
}

export function parsePage<T>(value: unknown, parse: (row: unknown) => T, page: number): Page<T> {
    const row = object(value)
    const meta = object(row.meta)
    if (
        !Array.isArray(row.data) ||
        meta.current_page !== page ||
        typeof meta.last_page !== 'number' ||
        !Number.isInteger(meta.last_page) ||
        meta.last_page < page
    )
        throw new Error('Invalid ModWorkshop pagination')
    return { data: row.data.map(parse), meta: { current_page: page, last_page: meta.last_page } }
}

export class ModWorkshop {
    private nextSlot = 0
    readonly counts = { requests: 0, retries: 0, versionBatches: 0 }
    constructor(
        private readonly base = process.env.MODWORKSHOP_API_BASE ?? 'https://api.modworkshop.net',
        private readonly fetcher: typeof fetch = fetch,
        private readonly sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms)),
        private readonly now = Date.now
    ) {}

    async get(path: string, params: Array<[string, string]> = []): Promise<unknown> {
        const url = new URL(this.base + path)
        for (const [key, value] of params) url.searchParams.append(key, value)
        for (let attempt = 0; attempt < 4; attempt++) {
            const slot = Math.max(this.now(), this.nextSlot)
            this.nextSlot = slot + 700
            if (slot > this.now()) await this.sleep(slot - this.now())
            this.counts.requests++
            let response: Response
            try {
                response = await this.fetcher(url, {
                    headers: { Accept: 'application/json', 'User-Agent': 'modrex-index-builder' },
                    signal: AbortSignal.timeout(30_000),
                })
            } catch (error) {
                if (attempt === 3) throw error
                this.counts.retries++
                await this.sleep(2_000 * 2 ** attempt)
                continue
            }
            if (response.ok) return response.json()
            const error = new ModWorkshopApiError(response.status, path)
            if (attempt === 3 || (![408, 429].includes(response.status) && response.status < 500))
                throw error
            this.counts.retries++
            const header = response.headers.get('retry-after')
            const seconds = header === null ? NaN : Number(header)
            const retry = Number.isFinite(seconds)
                ? seconds * 1000
                : header
                  ? Date.parse(header) - this.now()
                  : NaN
            await this.sleep(
                Number.isFinite(retry) ? Math.max(0, Math.min(60_000, retry)) : 2_000 * 2 ** attempt
            )
        }
        throw new Error('ModWorkshop retries exhausted')
    }

    async versions(requested: readonly number[]): Promise<Map<number, VersionResult>> {
        const ids = [...new Set(requested.map(id))]
        const results = new Map<number, VersionResult>()
        for (let offset = 0; offset < ids.length; offset += 100) {
            const chunk = ids.slice(offset, offset + 100)
            this.counts.versionBatches++
            try {
                const response = await this.get(
                    '/mods/versions',
                    chunk.map((id) => ['mod_ids[]', String(id)])
                )
                for (const [id, result] of parseVersions(response, chunk)) results.set(id, result)
            } catch (error) {
                for (const id of chunk) results.set(id, { status: 'failed', error: String(error) })
            }
        }
        return results
    }

    async listings(game: number, page: number): Promise<Page<ModListing>> {
        return parsePage(
            await this.get(`/games/${game}/mods`, [
                ['limit', '50'],
                ['sort', 'bumped_at'],
                ['page', String(page)],
            ]),
            parseListing,
            page
        )
    }

    private async all<T extends { id: number }>(
        path: string,
        parse: (row: unknown) => T
    ): Promise<T[]> {
        const rows = new Map<number, T>()
        let page = 1
        while (true) {
            const result = parsePage(
                await this.get(path, [
                    ['limit', '50'],
                    ['page', String(page)],
                ]),
                parse,
                page
            )
            for (const row of result.data) rows.set(row.id, row)
            if (page === result.meta.last_page) return [...rows.values()]
            page++
        }
    }
    files(modId: string) {
        return this.all(`/mods/${modId}/files`, parseFile)
    }
    links(modId: string) {
        return this.all(`/mods/${modId}/links`, parseLink)
    }
}

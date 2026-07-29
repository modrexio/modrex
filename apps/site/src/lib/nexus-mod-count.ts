import { GAMES } from '@modrex/games'

const NEXUS_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql'

// Games Modrex has a Nexus presence for, from the single shared registry - RAID has
// none and is naturally absent since its nexusDomain is unset. Cross-checked against
// the Rust SOURCE_REGISTRY by check-sources.mjs.
const NEXUS_GAME_DOMAINS = new Set(
    Object.values(GAMES)
        .map((g) => g.nexusDomain)
        .filter((d): d is string => d !== undefined)
)

interface NexusGameNode {
    domainName: string
    modCount: number | null
}

interface NexusGamesResponse {
    data?: {
        payday?: { nodes?: NexusGameNode[] }
        crimeBoss?: { nodes?: NexusGameNode[] }
    }
    errors?: unknown
}

export interface NexusModCounts {
    total: number
}

// Build-time only, a single small query (games() with a name filter, no per-mod
// enumeration), unauthenticated - Nexus's GraphQL API answers introspection and reads
// without a token (verified live). This is normal, occasional developer/build-time API
// use, not a production path that depends on the unauthenticated door staying open -
// see modrex-main's Nexus identification memory for why the desktop app instead routes
// every request through OAuth. Counts mods that EXIST on Nexus; never sum this into
// Modrex's own recognized-mod count, which counts mods Modrex can identify by hash.
export async function getNexusModCounts(): Promise<NexusModCounts | null> {
    const query = `{
        payday: games(filter: { name: [{ value: "PAYDAY", op: WILDCARD }] }, count: 10) {
            nodes { domainName modCount }
        }
        crimeBoss: games(filter: { name: [{ value: "Crime Boss", op: WILDCARD }] }, count: 10) {
            nodes { domainName modCount }
        }
    }`

    const res = await fetch(NEXUS_GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Modrex-Site/1.0 (+https://modrex.net)',
            'Application-Name': 'Modrex',
        },
        body: JSON.stringify({ query }),
    })
    if (!res.ok) throw new Error(`Nexus mod count download error: ${res.status}`)

    const body = (await res.json()) as NexusGamesResponse
    if (body.errors)
        throw new Error(`Nexus mod count graphql error: ${JSON.stringify(body.errors)}`)

    const nodes = [...(body.data?.payday?.nodes ?? []), ...(body.data?.crimeBoss?.nodes ?? [])]
    const total = nodes
        .filter((n) => NEXUS_GAME_DOMAINS.has(n.domainName))
        .reduce((sum, n) => sum + (n.modCount ?? 0), 0)

    if (total <= 0) return null
    return { total }
}

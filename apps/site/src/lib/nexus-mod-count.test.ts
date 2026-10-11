import { afterEach, expect, it, vi } from 'vitest'
import { getNexusModCounts } from './nexus-mod-count'

afterEach(() => vi.unstubAllGlobals())

it('counts Ready or Not and existing declared Nexus domains separately from the index', async () => {
    const fetch = vi.fn().mockResolvedValue(
        Response.json({
            data: {
                payday: {
                    nodes: [
                        { domainName: 'payday2', modCount: 10 },
                        { domainName: 'payday3', modCount: 20 },
                        { domainName: 'paydaytheheist', modCount: null },
                        { domainName: 'unknown', modCount: 1000 },
                    ],
                },
                crimeBoss: { nodes: [{ domainName: 'crimebossrockaycity', modCount: 30 }] },
                readyOrNot: { nodes: [{ domainName: 'readyornot', modCount: 40 }] },
            },
            stats: { supportedMods: 9999 },
        })
    )
    vi.stubGlobal('fetch', fetch)

    expect(await getNexusModCounts()).toEqual({ total: 100 })
    const request = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(request.body as string).query).toContain(
        'readyOrNot: games(filter: { name: [{ value: "Ready or Not", op: EQUALS }] }'
    )
})

it('reports an unsuccessful count response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(getNexusModCounts()).rejects.toThrow('Nexus mod count download error: 503')
})

it('reports GraphQL errors instead of publishing a partial count', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
            Response.json({
                data: { readyOrNot: { nodes: [{ domainName: 'readyornot', modCount: 40 }] } },
                errors: [{ message: 'Query failed' }],
            })
        )
    )
    await expect(getNexusModCounts()).rejects.toThrow('Nexus mod count graphql error')
})

it('returns no count when declared domains have no available mods', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
            Response.json({
                data: { readyOrNot: { nodes: [{ domainName: 'readyornot', modCount: 0 }] } },
            })
        )
    )
    expect(await getNexusModCounts()).toBeNull()
})

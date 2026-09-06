import { describe, it, expect, vi } from 'vitest'
import { attemptAll, describeFailures, runBulkAction } from './bulkAction'

describe('attemptAll', () => {
    // Stopping at the first failure leaves the rest of a selection untouched with nothing
    // said about which were reached, so every item is attempted.
    it('attempts every item even after one fails', async () => {
        const attempted: string[] = []
        const failures = await attemptAll(
            ['a', 'b', 'c'],
            (name) => name,
            async (name) => {
                attempted.push(name)
                if (name === 'b') throw new Error('locked')
            }
        )

        expect(attempted).toEqual(['a', 'b', 'c'])
        expect(failures).toHaveLength(1)
        expect(failures[0].name).toBe('b')
        expect(failures[0].error).toContain('locked')
    })

    it('reports nothing when every item succeeds', async () => {
        const failures = await attemptAll(
            ['a', 'b'],
            (n) => n,
            async () => {}
        )
        expect(failures).toEqual([])
    })

    it('collects every failure, in order', async () => {
        const failures = await attemptAll(
            ['a', 'b', 'c'],
            (n) => n,
            async (n) => {
                if (n !== 'b') throw new Error(`no ${n}`)
            }
        )
        expect(failures.map((f) => f.name)).toEqual(['a', 'c'])
    })
})

describe('describeFailures', () => {
    it('says nothing when there is nothing to say', () => {
        expect(describeFailures([])).toBeNull()
    })

    it('names the mod when one failed', () => {
        const message = describeFailures([{ name: 'Cool Mod', error: 'file is locked' }])
        expect(message).toContain('Cool Mod')
        expect(message).toContain('file is locked')
    })

    it('names every mod when several failed and carries one reason', () => {
        const message = describeFailures([
            { name: 'Alpha', error: 'file is locked' },
            { name: 'Beta', error: 'file is locked' },
        ])
        expect(message).toContain('Alpha')
        expect(message).toContain('Beta')
        expect(message).toContain('file is locked')
    })
})

describe('runBulkAction', () => {
    const ok = async (): Promise<void> => {}

    it('refreshes once after the action and reports nothing when both succeed', async () => {
        const refresh = vi.fn().mockResolvedValue(undefined)
        const message = await runBulkAction(['a', 'b'], (n) => n, ok, refresh)

        expect(message).toBeNull()
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('refreshes once even when every item failed', async () => {
        const refresh = vi.fn().mockResolvedValue(undefined)
        const message = await runBulkAction(
            ['a'],
            (n) => n,
            async () => {
                throw new Error('locked')
            },
            refresh
        )

        expect(message).toContain('locked')
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    // The callers are click handlers nobody awaits, so a rejection escaping here would skip
    // their loading-flag reset and land on the global unhandledrejection handler.
    it('reports a failed refresh instead of throwing', async () => {
        const refresh = vi.fn().mockRejectedValue(new Error('the list could not be read'))

        const message = await runBulkAction(['a'], (n) => n, ok, refresh)

        expect(message).toContain('the list could not be read')
    })

    // Two failures, one banner: which mod would not move is more actionable than the fact that
    // the list behind it is also unreadable.
    it('keeps the action failure when the refresh fails too', async () => {
        const message = await runBulkAction(
            ['a'],
            (n) => n,
            async () => {
                throw new Error('locked')
            },
            vi.fn().mockRejectedValue(new Error('the list could not be read'))
        )

        expect(message).toContain('locked')
        expect(message).not.toContain('the list could not be read')
    })

    it('attempts every item before refreshing', async () => {
        const order: string[] = []
        await runBulkAction(
            ['a', 'b'],
            (n) => n,
            async (n) => {
                order.push(n)
            },
            async () => {
                order.push('refresh')
            }
        )

        expect(order).toEqual(['a', 'b', 'refresh'])
    })
})

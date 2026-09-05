import { describe, it, expect } from 'vitest'
import { attemptAll, describeFailures } from './bulkAction'

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

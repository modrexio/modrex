import { describe, it, expect, vi } from 'vitest'
import type { ResourceReview } from './api'
import {
    finishResourceReview,
    getPendingResourceReview,
    requestResourceReview,
    resourceSelectionValid,
    resourceConflicts,
    subscribeResourceReview,
} from './resourceInstall'

const review: ResourceReview = {
    reviewHandle: 'pack',
    gameId: 'pd3',
    gamePath: '/games/pd3',
    configPath: '/config/Engine.ini',
    modName: 'Sample pack',
    pakPicker: null,
    source: null,
    moviePackApplied: false,
    movieConflicts: [],
    iniConflicts: [],
    movieSlots: ['StartUp_SBZ.bk2', 'StartUp_Unreal.bk2'],
    entries: [
        {
            entryId: 1,
            name: 'movie.bk2',
            kind: 'movie',
            supported: true,
            reason: null,
            changes: [],
            keys: [],
        },
        {
            entryId: 2,
            name: 'other.bk2',
            kind: 'movie',
            supported: true,
            reason: null,
            changes: [],
            keys: [],
        },
        {
            entryId: 3,
            name: '6/Engine.ini',
            kind: 'ini',
            supported: true,
            reason: null,
            changes: [],
            keys: [],
        },
        {
            entryId: 4,
            name: '9/Engine.ini',
            kind: 'ini',
            supported: true,
            reason: null,
            changes: [],
            keys: [],
        },
        {
            entryId: 5,
            name: 'UE4SS-settings.ini',
            kind: 'ini',
            supported: false,
            reason: 'Loader settings',
            changes: [],
            keys: [],
        },
    ],
}

describe('resource review selection', () => {
    it('requires a unique verified slot per movie and one INI variant', () => {
        expect(resourceSelectionValid(review, {})).toBe(false)
        expect(resourceSelectionValid(review, { 1: null })).toBe(false)
        expect(resourceSelectionValid(review, { 1: 'outside.bk2' })).toBe(false)
        expect(resourceSelectionValid(review, { 1: 'StartUp_SBZ.bk2', 2: 'StartUp_SBZ.bk2' })).toBe(
            false
        )
        expect(
            resourceSelectionValid(review, {
                1: 'StartUp_SBZ.bk2',
                2: 'StartUp_Unreal.bk2',
                3: null,
            })
        ).toBe(true)
        expect(resourceSelectionValid(review, { 3: null, 4: null })).toBe(false)
        expect(resourceSelectionValid(review, { 5: null })).toBe(false)
    })

    it('previews whole pack switches and restores only settings outside the selected preset', () => {
        const shared = { section: 'S', key: 'A', before: 'old', applied: 'same' }
        const disjoint = { section: 'S', key: 'B', before: null, applied: 'other' }
        const variant: ResourceReview = {
            ...review,
            movieConflicts: [
                {
                    name: 'Earlier intro pack',
                    slots: ['StartUp_SBZ.bk2', 'StartUp_Unreal.bk2'],
                    replacing: false,
                },
            ],
            iniConflicts: [
                { name: 'Previous preset', changes: [shared, disjoint], replacing: false },
            ],
            entries: review.entries.map((entry) =>
                entry.entryId === 3 ? { ...entry, keys: [{ section: 's', key: 'a' }] } : entry
            ),
        }
        expect(resourceConflicts(variant, {})).toEqual({ movies: [], presets: [] })
        expect(resourceConflicts(variant, { 1: 'StartUp_SBZ.bk2', 3: null })).toEqual({
            movies: [{ name: 'Earlier intro pack', restoredSlots: ['StartUp_Unreal.bk2'] }],
            presets: [{ name: 'Previous preset', restoredKeys: [disjoint] }],
        })
    })

    it('keeps concurrent installs waiting for their own review result', async () => {
        const listener = vi.fn()
        const unsubscribe = subscribeResourceReview(listener)
        const first = requestResourceReview('pd3')
        const second = requestResourceReview('cb')
        expect(getPendingResourceReview()).toBe('pd3')
        expect(() => finishResourceReview('cb', true)).toThrow('order changed')
        finishResourceReview('pd3', false)
        await expect(first).resolves.toBe(false)
        expect(getPendingResourceReview()).toBe('cb')
        finishResourceReview('cb', true)
        await expect(second).resolves.toBe(true)
        expect(getPendingResourceReview()).toBeNull()
        expect(listener).toHaveBeenCalledTimes(4)
        unsubscribe()
    })
})

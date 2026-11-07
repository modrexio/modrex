import { describe, expect, test } from 'bun:test'
import { assertAboveLatestStable, nightlyVersion } from './nightly-version.mts'

describe('nightlyVersion', () => {
    test('names the build after the next minor', () => {
        expect(nightlyVersion('0.16.1', '20261107', null)).toBe('0.17.0-nightly.20261107.1')
    })

    test('adds to the counter on the same base and date', () => {
        expect(nightlyVersion('0.16.1', '20261107', '0.17.0-nightly.20261107.9')).toBe(
            '0.17.0-nightly.20261107.10'
        )
    })

    test('starts over on a new date', () => {
        expect(nightlyVersion('0.16.1', '20261108', '0.17.0-nightly.20261107.4')).toBe(
            '0.17.0-nightly.20261108.1'
        )
    })

    test('starts over on a new base', () => {
        expect(nightlyVersion('0.17.0', '20261107', '0.17.0-nightly.20261107.4')).toBe(
            '0.18.0-nightly.20261107.1'
        )
    })

    test('refuses a version that is not plain', () => {
        expect(() => nightlyVersion('0.17.0-nightly.20261107.1', '20261107', null)).toThrow()
    })

    test('orders every step of the channel', () => {
        const order = [
            '0.16.1',
            nightlyVersion('0.16.1', '20261107', null),
            '0.17.0-nightly.20261107.2',
            '0.17.0-nightly.20261107.10',
            '0.17.0-nightly.20261108.1',
            '0.17.0',
            nightlyVersion('0.17.0', '20261201', null),
        ]
        for (let i = 1; i < order.length; i++) {
            expect(Bun.semver.order(order[i - 1]!, order[i]!)).toBe(-1)
        }
    })
})

describe('assertAboveLatestStable', () => {
    test('accepts a base above the latest release', () => {
        expect(() => assertAboveLatestStable('0.17.0-nightly.20261107.1', 'v0.16.1')).not.toThrow()
    })

    test('refuses a commit from before a release bump', () => {
        expect(() => assertAboveLatestStable('0.17.0-nightly.20261107.1', 'v0.17.0')).toThrow()
    })
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const astroRequire = createRequire(require.resolve('astro/package.json'))
const CachePolicy = astroRequire('http-cache-semantics')
const request = { method: 'GET', url: 'https://cache.example.test/image', headers: {} }

function cachePolicy(headers, options = {}, serialized = false) {
    const policy = new CachePolicy(
        { ...request, headers: options.authorization ? { authorization: 'Bearer fixture' } : {} },
        { status: 200, headers: { age: '60', ...headers } },
        { shared: options.shared !== false }
    )
    return serialized ? CachePolicy.fromObject(policy.toObject()) : policy
}

// GHSA-ch52-4w7c-c8xp is excepted only while every locked copy uses the tested patch.
test('all locked HTTP cache policies resolve to the verified 4.2.0 patch', () => {
    const lock = readFileSync(
        new URL('../../../pnpm-lock.yaml', import.meta.url),
        'utf8'
    ).replaceAll('\r\n', '\n')
    const snapshots = lock.split('\nsnapshots:\n')[1]
    assert.ok(snapshots, 'pnpm lockfile snapshots must be present')
    const keys = [...snapshots.matchAll(/^  http-cache-semantics@([^:]+):(?: \{\})?$/gmu)]
    assert.equal(keys.length, 1, 'every cache policy version needs its security assessment')
    assert.match(keys[0][1], /^4\.2\.0\(patch_hash=[a-z0-9]+\)$/u)
    const references = [...lock.matchAll(/^      http-cache-semantics: (.+)$/gmu)]
    assert.ok(references.length > 0)
    for (const [, version] of references) assert.equal(version, keys[0][1])
})

const restrictions = [
    ['shared cookie', { 'set-cookie': 'session=first-user', 'cache-control': 'max-age=10' }],
    ['proxy revalidation', { 'cache-control': 'max-age=10, proxy-revalidate' }],
    ['no-cache response', { 'cache-control': 'max-age=10, no-cache' }],
    ['private response', { 'cache-control': 'max-age=10, private' }],
    ['no-store response', { 'cache-control': 'max-age=10, no-store' }],
    ['authenticated response', { 'cache-control': 'max-age=10' }, { authorization: true }],
    ['must revalidate', { 'cache-control': 'max-age=10, must-revalidate' }],
    ['wildcard vary', { 'cache-control': 'max-age=10', vary: '*' }],
]

for (const serialized of [false, true]) {
    for (const [name, headers, options] of restrictions) {
        const label = name + (serialized ? ' after serialization' : '')
        test(label + ' rejects unbounded and numeric max-stale', () => {
            const policy = cachePolicy(headers, options, serialized)
            for (const directive of ['max-stale', 'max-stale=3600']) {
                const incoming = { ...request, headers: { 'cache-control': directive } }
                assert.equal(policy.satisfiesWithoutRevalidation(incoming), false)
                const result = policy.evaluateRequest(incoming)
                assert.equal(result.response, undefined)
                assert.equal(result.revalidation.synchronous, true)
            }
        })
        test(label + ' rejects stale-while-revalidate and has no reusable TTL', () => {
            const policy = cachePolicy(
                {
                    ...headers,
                    'cache-control': headers['cache-control'] + ', stale-while-revalidate=3600',
                },
                options,
                serialized
            )
            assert.equal(policy.useStaleWhileRevalidate(), false)
            assert.equal(policy.timeToLive(), 0)
            const result = policy.evaluateRequest(request)
            assert.equal(result.response, undefined)
            assert.equal(result.revalidation.synchronous, true)
        })
        test(label + ' rejects stale-if-error on an origin failure', () => {
            const policy = cachePolicy(
                { ...headers, 'cache-control': headers['cache-control'] + ', stale-if-error=3600' },
                options,
                serialized
            )
            assert.equal(policy.timeToLive(), 0)
            const result = policy.revalidatedPolicy(request, { status: 503, headers: {} })
            assert.equal(result.modified, true)
            assert.notEqual(result.policy, policy)
        })
    }
}

for (const [name, headers, options] of [
    ['ordinary expiration', { 'cache-control': 'max-age=10' }],
    ['explicit zero lifetime', { 'cache-control': 'max-age=0, public' }],
    [
        'public shared cookie',
        { 'cache-control': 'max-age=10, public', 'set-cookie': 'session=public' },
    ],
    [
        'immutable shared cookie',
        { 'cache-control': 'max-age=10, immutable', 'set-cookie': 'session=public' },
    ],
    [
        'private cookie cache',
        { 'cache-control': 'max-age=10', 'set-cookie': 'session=private' },
        { shared: false },
    ],
    [
        'private proxy-revalidate cache',
        { 'cache-control': 'max-age=10, proxy-revalidate' },
        { shared: false },
    ],
]) {
    test(name + ' still permits explicitly allowed stale reuse', () => {
        for (const serialized of [false, true]) {
            const policy = cachePolicy(headers, options, serialized)
            assert.equal(
                policy.satisfiesWithoutRevalidation({
                    ...request,
                    headers: { 'cache-control': 'max-stale=120' },
                }),
                true
            )
        }
    })
}

test('ordinary stale extensions remain usable', () => {
    const policy = cachePolicy({
        'cache-control': 'max-age=10, stale-while-revalidate=120, stale-if-error=120',
    })
    assert.equal(policy.useStaleWhileRevalidate(), true)
    assert.ok(policy.timeToLive() > 0)
    assert.equal(policy.evaluateRequest(request).revalidation.synchronous, false)
    const result = policy.revalidatedPolicy(request, { status: 503, headers: {} })
    assert.equal(result.modified, false)
    assert.equal(result.policy, policy)
})

test('fresh responses and bounded stale limits retain their cache behavior', () => {
    const fresh = cachePolicy({ 'cache-control': 'max-age=600' })
    assert.equal(fresh.satisfiesWithoutRevalidation(request), true)
    assert.ok(fresh.timeToLive() > 0)
    const stale = cachePolicy({ 'cache-control': 'max-age=10' })
    assert.equal(
        stale.satisfiesWithoutRevalidation({
            ...request,
            headers: { 'cache-control': 'max-stale=30' },
        }),
        false
    )
    const revalidate = cachePolicy({
        'cache-control': 'max-age=600, must-revalidate, stale-while-revalidate=3600',
    })
    assert.ok(revalidate.timeToLive() > 0)
    assert.ok(revalidate.timeToLive() <= 540000)
})

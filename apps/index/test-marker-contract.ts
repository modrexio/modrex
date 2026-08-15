// The indexer half of the representative-file contract. modrex-main runs the same vectors
// against its own picker (marker_contract_tests.rs), so a change that makes the two disagree
// fails here as well as there, instead of quietly producing hashes no installed copy can match.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooseMarker } from './postgres/marker-archive.js'

interface Case {
    name: string
    files: string[]
    expected: string | null
}

const contract = JSON.parse(
    readFileSync(join(import.meta.dirname, 'marker-contract.json'), 'utf8')
) as { cases: Case[] }

assert.ok(contract.cases.length > 0, 'the contract has vectors')

for (const testCase of contract.cases) {
    assert.equal(chooseMarker(testCase.files), testCase.expected, testCase.name)

    // Archives normally wrap their files in one folder named after the mod, which the picker
    // strips before comparing, so the same vectors must resolve to the same relative file.
    const wrapper = 'Some Mod v2/'
    const wrapped = testCase.files.map((path) => wrapper + path)
    const wrappedExpectation = testCase.expected === null ? null : wrapper + testCase.expected
    assert.equal(
        chooseMarker(wrapped),
        wrappedExpectation,
        `${testCase.name} (inside a wrapper folder)`
    )

    // Directory entries are listed by some archives and must never be picked.
    const withDirectories = [...wrapped, wrapper, `${wrapper}anims/`]
    assert.equal(
        chooseMarker(withDirectories),
        wrappedExpectation,
        `${testCase.name} (with directory entries present)`
    )
}

console.log(`marker contract test passed (${contract.cases.length} vectors)`)

// A refresh run content-processes exactly one game, so the selector decides which games
// stay indexable. Two properties have to hold together: no game holding pending work can
// be passed over indefinitely, and between those forced preemptions the largest backlog
// still wins. This pins both, plus the tie order the workflow depends on being stable.

import { strict as assert } from 'node:assert'

import { GAME_IDS, type GameId } from '@modrex/games'

import { SERVICE_CEILING, chooseNextGame, turnKey } from './postgres/game-schedule.js'

const BOUND = SERVICE_CEILING + GAME_IDS.length - 1

type Counts = Record<GameId, number>

interface Workload {
    real: Counts
    residue: Counts
}

interface Scenario {
    // Listings that yield to processing, drained at the run limit.
    real?: Partial<Counts>
    // Listings that stay pending however often they are processed, the way a dead
    // off-site link does. This is what distorts the pending count the selector reads.
    residue?: Partial<Counts>
    arrive?: (workload: Workload, run: number) => void
}

const zeroed = (): Counts => Object.fromEntries(GAME_IDS.map((game) => [game, 0])) as Counts

function simulate(scenario: Scenario, runs: number, limit = 1000) {
    const real = { ...zeroed(), ...scenario.real }
    const residue = { ...zeroed(), ...scenario.residue }
    const lastTurn = Object.fromEntries(GAME_IDS.map((game) => [game, null])) as Record<
        GameId,
        number | null
    >
    const picks = zeroed()
    const worstWait = zeroed()
    const pendingSince = Object.fromEntries(GAME_IDS.map((game) => [game, null])) as Record<
        GameId,
        number | null
    >
    const order: GameId[] = []
    let maxTurn = 0

    for (let run = 1; run <= runs; run++) {
        scenario.arrive?.({ real, residue }, run)

        for (const game of GAME_IDS) {
            const pending = real[game] + residue[game]
            if (pending === 0) pendingSince[game] = null
            else if (pendingSince[game] === null) pendingSince[game] = run
        }

        const candidates = GAME_IDS.filter((game) => real[game] + residue[game] > 0).map(
            (game) => ({ game, pending: real[game] + residue[game], lastTurn: lastTurn[game] })
        )
        const next = chooseNextGame(candidates, maxTurn)
        if (next) {
            order.push(next)
            picks[next]++
            maxTurn += 1
            lastTurn[next] = maxTurn
            real[next] = Math.max(0, real[next] - limit)
            pendingSince[next] = real[next] + residue[next] > 0 ? run + 1 : null
        }

        for (const game of GAME_IDS) {
            const since = pendingSince[game]
            if (since !== null) worstWait[game] = Math.max(worstWait[game], run - since + 1)
        }
    }

    const totalPicks = GAME_IDS.reduce((sum, game) => sum + picks[game], 0)
    return { picks, order, worstWait, totalPicks, real, residue }
}

const worstOf = (result: { worstWait: Counts }) =>
    Math.max(...GAME_IDS.map((game) => result.worstWait[game]))

// The metadata key the selector persists.

assert.equal(turnKey('pd2'), 'content_last_turn:pd2')

// Tier boundaries.

assert.equal(chooseNextGame([], 0), null, 'no pending work must select no game')

assert.equal(
    chooseNextGame(
        [
            { game: 'pd2', pending: 5000, lastTurn: 40 },
            { game: 'raid', pending: 1, lastTurn: null },
        ],
        40
    ),
    'raid',
    'a game the scheduler has never selected outranks one that holds a turn'
)

// The wait here is far past the ceiling, which is exactly the case that starves when a
// never-selected game is given a fixed wait equal to the ceiling instead of its own tier.
assert.equal(
    chooseNextGame(
        [
            { game: 'pd3', pending: 9, lastTurn: 1 },
            { game: 'raid', pending: 1, lastTurn: null },
        ],
        100
    ),
    'raid',
    'a never-selected game outranks a long-overdue one'
)

assert.equal(
    chooseNextGame(
        [
            { game: 'pd2', pending: 5000, lastTurn: 20 },
            { game: 'pd3', pending: 1, lastTurn: 20 - SERVICE_CEILING },
        ],
        20
    ),
    'pd3',
    'an overdue game outranks a far larger pending count'
)

assert.equal(
    chooseNextGame(
        [
            { game: 'pd2', pending: 5000, lastTurn: 20 },
            { game: 'pd3', pending: 1, lastTurn: 21 - SERVICE_CEILING },
        ],
        20
    ),
    'pd2',
    'one run short of the ceiling the largest pending count still wins'
)

// Deterministic ties.

assert.equal(
    chooseNextGame(
        [
            { game: 'pdth', pending: 7, lastTurn: 3 },
            { game: 'pd3', pending: 7, lastTurn: 3 },
        ],
        5
    ),
    'pd3',
    'equal pending and equal turns resolve in game id order'
)

// Catalogue order must not reach the scheduler: a game moving up the picker would otherwise
// gain refresh turns.
assert.equal(
    chooseNextGame(
        [
            { game: 'raid', pending: 7, lastTurn: 3 },
            { game: 'cb', pending: 7, lastTurn: 3 },
        ],
        5
    ),
    'cb',
    'ties resolve on the id, independent of catalogue order'
)

const tied = [
    { game: 'raid' as GameId, pending: 4, lastTurn: 2 },
    { game: 'pd2' as GameId, pending: 4, lastTurn: 2 },
]
assert.equal(chooseNextGame(tied, 5), chooseNextGame(tied, 5), 'selection must be repeatable')

// A game with no pending work consumes no capacity.

const idle = simulate({ residue: { pd2: 27 } }, 40)
assert.equal(idle.picks.pd2, 40, 'the only game with pending work takes every run')
assert.equal(
    GAME_IDS.filter((game) => game !== 'pd2').every((game) => idle.picks[game] === 0),
    true,
    'a game with no pending work is never selected'
)

// First deployment, from the pending counts standing when the scheduler landed.

const deployment = simulate(
    {
        real: { pd3: 1 },
        residue: { pd2: 27, pdth: 2 },
        arrive: (workload, run) => {
            if (run > 1) workload.real.pd2 += 1
        },
    },
    40
)
assert.deepEqual(
    deployment.order.slice(0, 3),
    ['pd2', 'pdth', 'pd3'],
    'with no persisted turns the never-selected games go first, largest pending first'
)

// The production defect this scheduler exists to fix.

const starvation = simulate(
    {
        real: { pd3: 1 },
        residue: { pd2: 27 },
        arrive: (workload) => {
            workload.real.pd2 += 1
        },
    },
    200
)
assert.equal(starvation.picks.pd3 > 0, true, 'a residue-backed trickle must not starve pd3')
assert.equal(
    worstOf(starvation) <= BOUND,
    true,
    `worst wait ${worstOf(starvation)} must stay within ${BOUND}`
)

// Bounded service across the shapes the pipeline actually produces.

const scenarios: Record<string, Scenario> = {
    'migration backlog and one new listing': { real: { pd2: 5000, raid: 1 } },
    'residue plus a listing every second run': {
        real: { pd3: 1 },
        residue: { pd2: 27 },
        arrive: (workload, run) => {
            if (run % 2 === 0) workload.real.pd2 += 1
        },
    },
    'several games carrying residue': {
        real: { pd3: 1 },
        residue: { pd2: 27, pdth: 2, raid: 5 },
        arrive: (workload) => {
            workload.real.pd2 += 1
        },
    },
    'every game residue only': { residue: { pd3: 3, pd2: 3, pdth: 3, cb: 3, raid: 3 } },
    'an empty game receives one listing': {
        residue: { pd2: 27 },
        arrive: (workload, run) => {
            workload.real.pd2 += 1
            if (run === 10) workload.real.raid += 1
        },
    },
    'a backlog lands on a quiet game': {
        real: { pd3: 1 },
        residue: { pd2: 27 },
        arrive: (workload, run) => {
            workload.real.pd2 += 1
            if (run === 10) workload.real.pdth += 5000
        },
    },
    'a game reaches zero and becomes pending again': {
        real: { pd2: 1_000_000 },
        arrive: (workload, run) => {
            if (run % 3 === 0) workload.real.pd3 += 1
        },
    },
    'dominant backlog against four permanent residues': {
        real: { pd2: 1_000_000 },
        residue: { pd3: 5, pdth: 5, cb: 5, raid: 5 },
    },
}

for (const [name, scenario] of Object.entries(scenarios)) {
    const result = simulate(scenario, 400)
    assert.equal(
        worstOf(result) <= BOUND,
        true,
        `${name}: worst wait ${worstOf(result)} exceeded ${BOUND}`
    )
}

// Comparable backlogs self-balance through the pending comparison.

const proportional = simulate(
    { real: { pd2: 5000, pd3: 4000, pdth: 3000, cb: 2000, raid: 1000 } },
    400
)
assert.deepEqual(
    {
        pd2: proportional.picks.pd2,
        pd3: proportional.picks.pd3,
        pdth: proportional.picks.pdth,
        cb: proportional.picks.cb,
        raid: proportional.picks.raid,
    },
    { pd2: 5, pd3: 4, pdth: 3, cb: 2, raid: 1 },
    'genuine backlogs are served in proportion to their size, not by rotation'
)
assert.equal(proportional.totalPicks, 15, 'no run is spent once every backlog has drained')

// A game that keeps winning the pending comparison keeps most of the runs.
// The share holds only while that game stays the largest, so the backlog here is far
// bigger than the run count can drain. Comparable backlogs are the case above.

const dominant = simulate(
    { real: { pd2: 1_000_000_000 }, residue: { pd3: 5, pdth: 5, cb: 5, raid: 5 } },
    3000
)
const dominantShare = dominant.picks.pd2 / dominant.totalPicks
const predictedShare = 1 - (GAME_IDS.length - 1) / (SERVICE_CEILING + 1)
assert.equal(
    Math.abs(dominantShare - predictedShare) < 0.01,
    true,
    `dominant share ${dominantShare.toFixed(3)} must hold near ${predictedShare.toFixed(3)}`
)

// Randomised shapes, because the bound has to survive candidates coming and going.

let seed = 20260816
const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
}

for (let trial = 0; trial < 100; trial++) {
    const result = simulate(
        {
            real: Object.fromEntries(
                GAME_IDS.map((game) => [game, random() < 0.4 ? Math.floor(random() * 5000) : 0])
            ),
            residue: Object.fromEntries(
                GAME_IDS.map((game) => [game, random() < 0.5 ? Math.floor(random() * 30) : 0])
            ),
            arrive: (workload) => {
                for (const game of GAME_IDS) {
                    if (random() < 0.15) workload.real[game] += Math.floor(random() * 40)
                    if (random() < 0.02) workload.residue[game] = Math.floor(random() * 30)
                    if (random() < 0.02) workload.residue[game] = 0
                }
            },
        },
        500
    )
    assert.equal(
        worstOf(result) <= BOUND,
        true,
        `randomised trial ${trial}: worst wait ${worstOf(result)} exceeded ${BOUND}`
    )
}

console.log('game schedule tests passed')

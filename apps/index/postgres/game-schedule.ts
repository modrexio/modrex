import { type GameId } from '@modrex/games'

export interface ScheduleCandidate {
    game: GameId
    pending: number
    // The scheduler turn this game was last selected at, or null if it never has been.
    lastTurn: number | null
}

// Eight turns retain a dominant backlog's majority when four rivals stay pending.
// Raising the ceiling gives that backlog more turns and postpones forced rival service.
// test-game-schedule.ts enforces the service bound and active-competitor share.
export const SERVICE_CEILING = 8

export function turnKey(game: GameId): string {
    return `content_last_turn:${game}`
}

// Selection is blind to why a listing is pending, because mod_checks records no failure
// reason: a permanently unreachable download counts exactly like a newly published mod.
// The ceiling is what keeps that inaccuracy from letting one game hold the scheduler.
export function chooseNextGame(candidates: ScheduleCandidate[], maxTurn: number): GameId | null {
    if (candidates.length === 0) return null

    // Ties resolve on the game id so a run is reproducible. Catalogue order must not decide
    // this: it is presentation, and a game moving up the picker would gain refresh turns.
    const byId = (left: ScheduleCandidate, right: ScheduleCandidate) =>
        left.game < right.game ? -1 : left.game > right.game ? 1 : 0
    const byPending = (left: ScheduleCandidate, right: ScheduleCandidate) =>
        right.pending - left.pending || byId(left, right)

    const unselected: ScheduleCandidate[] = []
    const scheduled: Array<{ candidate: ScheduleCandidate; wait: number }> = []
    for (const candidate of candidates) {
        if (candidate.lastTurn === null) unselected.push(candidate)
        else scheduled.push({ candidate, wait: maxTurn - candidate.lastTurn })
    }

    // A game the scheduler has never selected outranks every game that holds a turn.
    // Giving it a fixed wait equal to the ceiling instead ties it with every merely
    // overdue game, and one late in id order then loses that tie on every run.
    if (unselected.length > 0) return unselected.sort(byPending)[0].game

    const overdue = scheduled.filter((entry) => entry.wait >= SERVICE_CEILING)
    if (overdue.length > 0) {
        return overdue.sort(
            (left, right) => right.wait - left.wait || byPending(left.candidate, right.candidate)
        )[0].candidate.game
    }

    return scheduled.sort(
        (left, right) =>
            right.candidate.pending - left.candidate.pending ||
            right.wait - left.wait ||
            byId(left.candidate, right.candidate)
    )[0].candidate.game
}

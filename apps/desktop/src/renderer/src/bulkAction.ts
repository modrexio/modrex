import { t } from './i18n'

export interface ActionFailure {
    name: string
    error: string
}

/**
 * Runs one action per mod and attempts every one, collecting the failures.
 *
 * Stopping at the first failure leaves the rest untouched with nothing said about which were
 * reached, and the ones that already succeeded have already been written to disk. A locked
 * file in the middle of a folder toggle should not decide the fate of the mods after it.
 */
export async function attemptAll<T>(
    items: T[],
    nameOf: (item: T) => string,
    run: (item: T) => Promise<void>
): Promise<ActionFailure[]> {
    const failures: ActionFailure[] = []
    for (const item of items) {
        try {
            await run(item)
        } catch (e) {
            failures.push({ name: nameOf(item), error: String(e) })
        }
    }
    return failures
}

/**
 * One message for a batch. A single failure reads as itself; several name the mods and carry
 * the first reason, which is almost always the reason for all of them.
 */
export function describeFailures(failures: ActionFailure[]): string | null {
    if (failures.length === 0) return null
    if (failures.length === 1) {
        return t('installed.actionFailed', {
            name: failures[0].name,
            error: failures[0].error,
        })
    }
    return t('installed.actionFailedSome', {
        count: failures.length,
        names: failures.map((f) => f.name).join(', '),
        error: failures[0].error,
    })
}

/**
 * Runs an action over every item and then refreshes once, returning the message to show.
 *
 * The refresh is what makes the list show what is on disk rather than what was asked for, so it
 * runs whether or not the action failed. Its own failure is returned rather than thrown: the
 * callers are click handlers that nobody awaits, so a rejection escaping here would leave their
 * loading flag set and reach the global unhandledrejection handler instead of the banner.
 */
export async function runBulkAction<T>(
    items: T[],
    nameOf: (item: T) => string,
    run: (item: T) => Promise<void>,
    refresh: () => Promise<void>
): Promise<string | null> {
    const actionError = describeFailures(await attemptAll(items, nameOf, run))
    try {
        await refresh()
    } catch (e) {
        // The action's own failure is the more specific one, so it keeps the single banner.
        return actionError ?? t('installed.refreshFailed', { error: String(e) })
    }
    return actionError
}

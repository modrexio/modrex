import { useEffect, useRef } from 'react'
import type { GameId, InstalledMod } from '../../../shared/types'
import { hasCatalogLink } from './installedUtils'
import { hasSource } from '../sources'
import { waitForForegroundClear } from '../requestPriority'
import { useNexusAuthEpoch } from '../nexusModCache'
import { api } from '../api'

const STAGGER_MS = 2000

interface Options {
    installed: InstalledMod[]
    gamePath: string | null
    activeGame: GameId
    onRefreshInstalled: () => Promise<void>
}

// Background counterpart to useModActions' manual "Identify" action: the first time a
// mod appears unidentified, try Nexus's content index once, automatically. Never
// re-attempts a mod that already has an outcome recorded (a real identity, or
// nexusContentMissed) - this only ever covers a mod's first appearance, same
// precondition identify_via_nexus_content_op itself enforces server-side. Staggered and
// yielding to foreground activity so it never competes with the user's own browsing or
// install actions on the shared rate-limited Nexus connection, mirroring
// nexusModCache.ts's fetchInstalledNexusModsMeta trickle.
export function useAutoIdentifyNexusMods({
    installed,
    gamePath,
    activeGame,
    onRefreshInstalled,
}: Options): void {
    const attempted = useRef<Set<string>>(new Set())
    const running = useRef(false)
    const nexusAuthEpoch = useNexusAuthEpoch()

    // A mod is attempted once per game, and once per Nexus session: an attempt that only
    // failed because the token was dead is not an answer, and without the reset it would
    // never be asked again for the rest of the session.
    useEffect(() => {
        attempted.current = new Set()
    }, [activeGame, nexusAuthEpoch])

    useEffect(() => {
        if (!gamePath || running.current || !hasSource(activeGame, 'nexus')) return
        const candidates = installed.filter(
            (m) =>
                !hasCatalogLink(m) &&
                m.nexusContentMissed !== true &&
                !m.missing &&
                !attempted.current.has(m.uid)
        )
        if (candidates.length === 0) return

        running.current = true
        let cancelled = false

        void (async () => {
            for (const mod of candidates) {
                if (cancelled) break
                attempted.current.add(mod.uid)
                await waitForForegroundClear()
                if (cancelled) break
                try {
                    await api.identifyModViaNexusContent(mod.uid, gamePath, activeGame)
                    await onRefreshInstalled()
                } catch (e) {
                    // Best-effort: a background pass must not interrupt the user with a
                    // failure toast for a mod they never asked about. The manual Identify
                    // button still surfaces a real error on request.
                    console.error(`Background Nexus identification failed for ${mod.uid}`, e)
                }
                await new Promise((resolve) => setTimeout(resolve, STAGGER_MS))
            }
            running.current = false
        })()

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [installed, gamePath, activeGame, nexusAuthEpoch])
}

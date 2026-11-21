import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ProfileList, type ProfileSource } from '../api'
import { t } from '../i18n'

export interface Profiles {
    list: ProfileList | null
    // The profile a switch is running toward, while it runs.
    switching: string | null
    error: string | null
    clearError: () => void
    switchTo: (profileId: string) => Promise<void>
    create: (name: string, source: ProfileSource) => Promise<boolean>
    rename: (profileId: string, name: string) => Promise<boolean>
    remove: (profileId: string) => Promise<void>
    dismissPending: (memberKey: number) => Promise<void>
    // An import created and switched to a profile, so both lists are out of date.
    imported: () => Promise<void>
}

export function useProfiles(
    gameId: string,
    gamePath: string | null,
    onRefreshInstalled: () => Promise<void>
): Profiles {
    const [list, setList] = useState<ProfileList | null>(null)
    const [switching, setSwitching] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    // A list requested for a copy of the game the page has since left must not replace the
    // list of the copy it shows now.
    const latest = useRef(0)

    const reload = useCallback(async () => {
        if (!gamePath) return
        const request = ++latest.current
        try {
            const next = await api.listProfiles(gameId, gamePath)
            if (request === latest.current) setList(next)
        } catch (e) {
            if (request === latest.current) {
                setError(t('installed.profiles.loadFailed', { error: String(e) }))
            }
        }
    }, [gameId, gamePath])

    useEffect(() => {
        setList(null)
        void reload()
    }, [reload])

    // A Nexus download can complete a shared mod the active profile was waiting for.
    useEffect(
        () =>
            api.onNexusInstallComplete((installed) => {
                if (installed.gameId === gameId) void reload()
            }),
        [gameId, reload]
    )

    const nameOf = (profileId: string) => list?.profiles.find((p) => p.id === profileId)?.name ?? ''

    // Each change reports through error and resolves false on failure, so a dialog stays open
    // with the name the user typed.
    async function change(run: () => Promise<unknown>): Promise<boolean> {
        setError(null)
        try {
            await run()
            return true
        } catch (e) {
            setError(t('installed.profiles.failed', { error: String(e) }))
            return false
        } finally {
            await reload()
        }
    }

    async function switchTo(profileId: string) {
        if (!gamePath) return
        setSwitching(profileId)
        setError(null)
        try {
            await api.switchProfile(gameId, gamePath, profileId)
        } catch (e) {
            setError(
                t('installed.profiles.switchFailed', {
                    name: nameOf(profileId),
                    error: String(e),
                })
            )
        }
        // A switch that stopped part way still moved files, so both lists are read either way,
        // and the page stays busy until they show where the mods are now.
        try {
            await reload()
            await onRefreshInstalled()
        } catch (e) {
            setError(t('installed.refreshFailed', { error: String(e) }))
        } finally {
            setSwitching(null)
        }
    }

    return {
        list,
        switching,
        error,
        clearError: () => setError(null),
        switchTo,
        create: (name, source) => change(() => api.createProfile(gameId, gamePath!, name, source)),
        rename: (profileId, name) =>
            change(() => api.renameProfile(gameId, gamePath!, profileId, name)),
        remove: async (profileId) => {
            await change(() => api.deleteProfile(gameId, gamePath!, profileId))
        },
        dismissPending: async (memberKey) => {
            await change(() => api.dismissPendingShareMember(gameId, gamePath!, memberKey))
        },
        imported: async () => {
            try {
                await reload()
                await onRefreshInstalled()
            } catch (e) {
                setError(t('installed.refreshFailed', { error: String(e) }))
            }
        },
    }
}

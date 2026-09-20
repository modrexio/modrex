import { useEffect, useSyncExternalStore } from 'react'
import { modVersions, type VersionState } from '../modVersions'

export function useModVersions(ids: readonly number[]): Map<number, VersionState> {
    useSyncExternalStore(modVersions.subscribe, modVersions.snapshot)
    const key = [...new Set(ids)].sort((a, b) => a - b).join(',')
    useEffect(() => {
        const requested = key ? key.split(',').map(Number) : []
        const refresh = () => {
            void modVersions.refresh(requested)
        }
        refresh()
        window.addEventListener('focus', refresh)
        const timer = setInterval(refresh, 30_000)
        return () => {
            clearInterval(timer)
            window.removeEventListener('focus', refresh)
        }
    }, [key])
    return new Map(ids.map((id) => [id, modVersions.read(id)]))
}

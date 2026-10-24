import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from './api'
import type { ThumbnailSize } from './api'

const resolved = new Map<string, string>()
const inFlight = new Map<string, Promise<string>>()

const variantKey = (filename: string, size: ThumbnailSize) => `${size}:${filename}`

export function getCachedThumbnailUrl(
    filename: string,
    size: ThumbnailSize = 'small'
): string | undefined {
    return resolved.get(variantKey(filename, size))
}

// Disk cache clearing must also invalidate URLs and pending requests for deleted files.
export function clearResolvedThumbnails(): void {
    resolved.clear()
    inFlight.clear()
}

export function getLocalImage(filename: string, size: ThumbnailSize = 'small'): Promise<string> {
    if (filename.startsWith('https://')) return Promise.resolve(filename)
    const key = variantKey(filename, size)
    const hit = resolved.get(key)
    if (hit) return Promise.resolve(hit)
    const pending = inFlight.get(key)
    if (pending) return pending

    const request = api
        .getThumbnail(filename, size)
        .then((cacheName) => {
            const url = convertFileSrc(cacheName, 'thumb')
            if (inFlight.get(key) === request) resolved.set(key, url)
            return url
        })
        .finally(() => {
            if (inFlight.get(key) === request) inFlight.delete(key)
        })
    inFlight.set(key, request)
    return request
}

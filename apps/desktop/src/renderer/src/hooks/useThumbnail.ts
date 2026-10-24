import { useState, useEffect } from 'react'
import { warn } from '@tauri-apps/plugin-log'
import type { ThumbnailSize } from '../api'
import { THUMBNAIL_BASE_URL } from '../../../shared/types'
import { getCachedThumbnailUrl, getLocalImage } from '../thumbnailCache'

// How long to wait for the local disk cache before falling back to the CDN.
// Disk hits resolve in single-digit milliseconds; only thumbnails the backend
// still has to download exceed this.
const LOCAL_RACE_MS = 50

export function useThumbnail(
    file: string | null | undefined,
    size: ThumbnailSize = 'small'
): string | null {
    const [src, setSrc] = useState<string | null>(() => {
        if (!file) return null
        // Absolute URLs (Nexus-sourced installs) bypass the local cache; the
        // filename-keyed disk cache only knows modworkshop's CDN.
        if (file.startsWith('https://')) return file
        return getCachedThumbnailUrl(file, size) ?? null
    })

    useEffect(() => {
        if (!file) {
            setSrc(null)
            return
        }
        if (file.startsWith('https://')) {
            setSrc(file)
            return
        }
        const cached = getCachedThumbnailUrl(file, size)
        if (cached) {
            setSrc(cached)
            return
        }
        // Cards must await resizing to avoid decoding originals in the grid. Other
        // variants keep the first source that resolves to avoid visible reloads.
        let cancelled = false
        const timer = setTimeout(() => {
            if (!cancelled && size !== 'card')
                setSrc((prev) => prev ?? `${THUMBNAIL_BASE_URL}/${file}`)
        }, LOCAL_RACE_MS)
        getLocalImage(file, size)
            .then((url) => {
                if (cancelled) return
                clearTimeout(timer)
                setSrc((prev) => prev ?? url)
            })
            .catch((error) => {
                void warn(`Thumbnail failed for ${file}: ${String(error)}`)
            })
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [file, size])

    return src
}

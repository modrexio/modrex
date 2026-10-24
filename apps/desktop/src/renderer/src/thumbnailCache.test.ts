import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ api: { getThumbnail: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (name: string) => `thumb://${name}` }))

import { api } from './api'
import { clearResolvedThumbnails, getCachedThumbnailUrl, getLocalImage } from './thumbnailCache'

beforeEach(() => {
    clearResolvedThumbnails()
    vi.resetAllMocks()
})

it('shares pending requests and keeps all three variants separate', async () => {
    let resolve!: (value: string) => void
    vi.mocked(api.getThumbnail).mockImplementation(
        () =>
            new Promise((done) => {
                resolve = done
            })
    )
    const first = getLocalImage('a.webp', 'card')
    expect(getLocalImage('a.webp', 'card')).toBe(first)
    expect(api.getThumbnail).toHaveBeenCalledTimes(1)
    resolve('card_a.webp.jpg')
    expect(await first).toBe('thumb://card_a.webp.jpg')
    expect(getCachedThumbnailUrl('a.webp', 'card')).toBe('thumb://card_a.webp.jpg')
    expect(getCachedThumbnailUrl('a.webp')).toBeUndefined()
    expect(getCachedThumbnailUrl('a.webp', 'full')).toBeUndefined()
    vi.mocked(api.getThumbnail).mockResolvedValue('a.webp')
    await getLocalImage('a.webp', 'full')
    await getLocalImage('a.webp')
    expect(api.getThumbnail).toHaveBeenCalledTimes(3)
})

it('rejects every caller and permits retry after failure', async () => {
    const error = new Error('download failed')
    vi.mocked(api.getThumbnail).mockRejectedValueOnce(error).mockResolvedValue('a.jpg')
    const first = getLocalImage('a.jpg')
    const second = getLocalImage('a.jpg')
    const results = await Promise.allSettled([first, second])
    expect(results).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
    ])
    expect(await getLocalImage('a.jpg')).toBe('thumb://a.jpg')
    expect(api.getThumbnail).toHaveBeenCalledTimes(2)
})

it('does not repopulate cleared URLs from an older request', async () => {
    let resolve!: (value: string) => void
    vi.mocked(api.getThumbnail)
        .mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done
                })
        )
        .mockResolvedValue('new.jpg')
    const old = getLocalImage('a.jpg')
    clearResolvedThumbnails()
    const fresh = getLocalImage('a.jpg')
    resolve('old.jpg')
    await old
    expect(await fresh).toBe('thumb://new.jpg')
    expect(getCachedThumbnailUrl('a.jpg')).toBe('thumb://new.jpg')
})

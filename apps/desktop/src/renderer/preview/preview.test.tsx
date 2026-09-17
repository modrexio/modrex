import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GAMES } from '@modrex/games'
import pd3Mods from './fixtures/pd3/mods.json'
import pd3ModRecords from './fixtures/pd3/mod-records.json'
import pd3News from './fixtures/pd3/news.json'
import pd2Mods from './fixtures/pd2/mods.json'
import pd2ModRecords from './fixtures/pd2/mod-records.json'
import type { ListModsParams, ModSummary } from '../../shared/bindings'

const store = new Map<string, string>()

beforeEach(() => {
    window.history.replaceState({}, '', '/')
    store.clear()
    store.set('modrex:active-game', 'pd3')
    store.set('modrex:active-view', 'browse')
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
    })
})

afterEach(cleanup)

// Every preview state is a fresh page load, so each test gets fresh module state on both
// sides: the renderer's session caches and the preview's in-memory library.
async function mount() {
    vi.resetModules()
    const { default: App } = await import('../src/App')
    render(<App />)
}

const found = (text: string) => screen.findByText(text, {}, { timeout: 5000 })

test('browse page renders the fixture listing without a backend', async () => {
    await mount()
    for (const mod of pd3Mods.data.slice(0, 3)) expect(await found(mod.name)).toBeTruthy()
})

test('opening a card renders the mod detail page', async () => {
    await mount()
    const first = pd3Mods.data[0]
    fireEvent.click(await found(first.name))
    const record = pd3ModRecords[String(first.id) as keyof typeof pd3ModRecords]
    expect(await found('Description')).toBeTruthy()
    expect(await found('Back')).toBeTruthy()
    expect((await screen.findAllByText(record.detail.user.name)).length).toBeGreaterThan(1)
})

test('news page renders the snapshot feed', async () => {
    store.set('modrex:active-view', 'news')
    await mount()
    expect(await found(pd3News.items[0].title)).toBeTruthy()
})

test('settings page renders the game path', async () => {
    store.set('modrex:active-view', 'settings')
    await mount()
    expect(await found('C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3')).toBeTruthy()
})

test('another game loads its own fixtures', async () => {
    store.set('modrex:active-game', 'pd2')
    await mount()
    expect(await found(pd2Mods.data[0].name)).toBeTruthy()
})

test('browse fixtures honor filters, sorting, and the captured page boundary', async () => {
    vi.resetModules()
    const { commands } = await import('./commands')
    const workshopId = GAMES.pd3.workshopId
    if (workshopId == null) throw new Error('PAYDAY 3 has no ModWorkshop id')
    const base = {
        query: null,
        limit: 24,
        sort: 'bumped_at',
        category_id: null,
        page: 1,
        ids: null,
        tags: null,
        block_tags: null,
    } satisfies ListModsParams
    const records = pd3ModRecords as Record<string, { detail: { tags: Array<{ id: number }> } }>

    const initial = await commands.listMods(workshopId, base)
    expect(initial.data.length).toBeGreaterThan(0)
    expect(initial.meta).toMatchObject({
        current_page: 1,
        last_page: 1,
        total: initial.data.length,
    })

    const categoryId = initial.data[0].category_id
    const category = await commands.listMods(workshopId, { ...base, category_id: categoryId })
    expect(category.data.length).toBeGreaterThan(0)
    expect(category.data.every((mod) => mod.category_id === categoryId)).toBe(true)

    const tagIds = [
        ...new Set(
            initial.data.flatMap((mod) => records[String(mod.id)].detail.tags.map((t) => t.id))
        ),
    ].slice(0, 2)
    expect(tagIds).toHaveLength(2)
    const included = await commands.listMods(workshopId, { ...base, tags: tagIds })
    expect(included.data.length).toBeGreaterThan(0)
    expect(
        included.data.every((mod) =>
            records[String(mod.id)].detail.tags.some((tag) => tagIds.includes(tag.id))
        )
    ).toBe(true)
    const blocked = await commands.listMods(workshopId, { ...base, block_tags: tagIds })
    expect(
        blocked.data.every((mod) =>
            records[String(mod.id)].detail.tags.every((tag) => !tagIds.includes(tag.id))
        )
    ).toBe(true)

    const sorts: Record<string, (a: ModSummary, b: ModSummary) => number> = {
        bumped_at: (a, b) => Date.parse(b.bumped_at) - Date.parse(a.bumped_at),
        published_at: (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
        downloads: (a, b) => b.downloads - a.downloads,
        likes: (a, b) => b.likes - a.likes,
        name: (a, b) => a.name.localeCompare(b.name),
    }
    for (const [sort, compare] of Object.entries(sorts)) {
        const sorted = await commands.listMods(workshopId, { ...base, sort })
        expect(sorted.data.map((mod) => mod.id)).toEqual(
            [...initial.data].sort(compare).map((mod) => mod.id)
        )
    }

    await expect(commands.listMods(workshopId, { ...base, page: 2 })).rejects.toThrow(
        'preview: no fixture for mods page 2'
    )
})

test('installing from a card lands the mod in the library', async () => {
    await mount()
    const first = pd3Mods.data[0]
    await found(first.name)
    fireEvent.click((await screen.findAllByText('Install'))[0])
    expect(await screen.findByText(/^\d+%$/)).toBeTruthy()
    const toggle = await screen.findByRole('switch', {}, { timeout: 5000 })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(await found('Installed'))
    expect(await found('1 mod')).toBeTruthy()
})

test('the demo library profile seeds representative installed states', async () => {
    window.history.replaceState({}, '', '/?library=demo')
    store.set('modrex:active-view', 'installed')
    await mount()
    expect(await found('6 mods')).toBeTruthy()
    expect(await found('Cosmetics')).toBeTruthy()
})

test('the large library profile generates unique entries from captured records', async () => {
    window.history.replaceState({}, '', '/?library=large')
    store.set('modrex:active-view', 'installed')
    vi.resetModules()
    const [{ commands }, { LARGE_LIBRARY_SIZE }] = await Promise.all([
        import('./commands'),
        import('./library'),
    ])
    const installed = await commands.getInstalled('pd3')
    expect(installed.mods).toHaveLength(LARGE_LIBRARY_SIZE)
    expect(new Set(installed.mods.map((mod) => mod.uid)).size).toBe(LARGE_LIBRARY_SIZE)
    expect(installed.folders).toHaveLength(5)

    const { default: App } = await import('../src/App')
    render(<App />)
    expect(await found(`${LARGE_LIBRARY_SIZE} mods`)).toBeTruthy()
})

test('preview state dimensions compose without duplicating fixtures', async () => {
    window.history.replaceState({}, '', '/?library=large&network=offline')
    vi.resetModules()
    const [{ commands }, { LARGE_LIBRARY_SIZE }] = await Promise.all([
        import('./commands'),
        import('./library'),
    ])
    expect((await commands.getInstalled('pd3')).mods).toHaveLength(LARGE_LIBRARY_SIZE)
    await expect(commands.listMods(853, null)).rejects.toThrow(
        'Temporary failure in name resolution'
    )
})

test('legacy scenario links remain compatible', async () => {
    window.history.replaceState({}, '', '/?scenario=library')
    vi.resetModules()
    const { previewState } = await import('./previewState')
    expect(previewState).toMatchObject({ library: 'demo' })
})

test('invalid and mixed preview state parameters fail at the URL boundary', async () => {
    window.history.replaceState({}, '', '/?library=huge')
    vi.resetModules()
    await expect(import('./previewState')).rejects.toThrow('preview: unknown library huge')

    window.history.replaceState({}, '', '/?library=toString')
    vi.resetModules()
    await expect(import('./previewState')).rejects.toThrow('preview: unknown library toString')

    window.history.replaceState({}, '', '/?scenario=library&network=offline')
    vi.resetModules()
    await expect(import('./previewState')).rejects.toThrow(
        'preview: scenario cannot be combined with preview state parameters'
    )
})

test('the missing-games state shows the missing installation state', async () => {
    window.history.replaceState({}, '', '/?games=missing')
    await mount()
    expect(await found('Game not found: install disabled')).toBeTruthy()
})

test('the offline network state surfaces the request failure', async () => {
    window.history.replaceState({}, '', '/?network=offline')
    await mount()
    expect(await found("Couldn't load mods")).toBeTruthy()
})

test('the first-run onboarding state asks for telemetry consent', async () => {
    window.history.replaceState({}, '', '/?onboarding=first-run')
    await mount()
    expect((await screen.findAllByText('Help improve Modrex')).length).toBeGreaterThan(0)
})

test('thumbnails fall back to the original when the catalog has no small variant', async () => {
    vi.resetModules()
    const { commands } = await import('./commands')
    await commands.listMods(1, null)
    const images = Object.values(pd2ModRecords).flatMap((record) => record.detail.images)
    const withSmall = images.find((image) => image.has_thumb)!
    const withoutSmall = images.find((image) => !image.has_thumb)!
    expect(await commands.getThumbnail(withSmall.file, false)).toBe(`thumbnail_${withSmall.file}`)
    expect(await commands.getThumbnail(withoutSmall.file, false)).toBe(withoutSmall.file)
    expect(await commands.getThumbnail(withoutSmall.file, true)).toBe(withoutSmall.file)
})

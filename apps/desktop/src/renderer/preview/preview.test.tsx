import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import pd3Mods from './fixtures/pd3/mods.json'
import pd3ModRecords from './fixtures/pd3/mod-records.json'
import pd3News from './fixtures/pd3/news.json'
import pd2Mods from './fixtures/pd2/mods.json'
import pd2ModRecords from './fixtures/pd2/mod-records.json'

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

// Every scenario is a fresh page load, so each test gets fresh module state on both
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

test('the library scenario seeds installed mods', async () => {
    window.history.replaceState({}, '', '/?scenario=library')
    store.set('modrex:active-view', 'installed')
    await mount()
    expect(await found('6 mods')).toBeTruthy()
    expect(await found('Cosmetics')).toBeTruthy()
})

test('the no-game scenario shows the missing installation state', async () => {
    window.history.replaceState({}, '', '/?scenario=no-game')
    await mount()
    expect(await found('Game not found: install disabled')).toBeTruthy()
})

test('the offline scenario surfaces the request failure', async () => {
    window.history.replaceState({}, '', '/?scenario=offline')
    await mount()
    expect(await found("Couldn't load mods")).toBeTruthy()
})

test('the first-run scenario asks for telemetry consent', async () => {
    window.history.replaceState({}, '', '/?scenario=first-run')
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

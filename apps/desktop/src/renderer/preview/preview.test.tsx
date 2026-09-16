import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../src/App'
import pd3Mods from './fixtures/pd3/mods.json'
import pd3ModRecords from './fixtures/pd3/mod-records.json'
import pd3News from './fixtures/pd3/news.json'
import pd2Mods from './fixtures/pd2/mods.json'

const store = new Map<string, string>()

beforeEach(() => {
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

const found = (text: string) => screen.findByText(text, {}, { timeout: 5000 })

test('browse page renders the fixture listing without a backend', async () => {
    render(<App />)
    for (const mod of pd3Mods.data.slice(0, 3)) expect(await found(mod.name)).toBeTruthy()
})

test('opening a card renders the mod detail page', async () => {
    render(<App />)
    const first = pd3Mods.data[0]
    fireEvent.click(await found(first.name))
    const record = pd3ModRecords[String(first.id) as keyof typeof pd3ModRecords]
    expect(await found('Description')).toBeTruthy()
    expect(await found('Back')).toBeTruthy()
    expect((await screen.findAllByText(record.detail.user.name)).length).toBeGreaterThan(1)
})

test('news page renders the snapshot feed', async () => {
    store.set('modrex:active-view', 'news')
    render(<App />)
    expect(await found(pd3News.items[0].title)).toBeTruthy()
})

test('settings page renders the game path', async () => {
    store.set('modrex:active-view', 'settings')
    render(<App />)
    expect(await found('C:\\Program Files (x86)\\Steam\\steamapps\\common\\PAYDAY 3')).toBeTruthy()
})

test('another game loads its own fixtures', async () => {
    store.set('modrex:active-game', 'pd2')
    render(<App />)
    expect(await found(pd2Mods.data[0].name)).toBeTruthy()
})

test('installing from a card lands the mod in the library', async () => {
    render(<App />)
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
}, 15000)

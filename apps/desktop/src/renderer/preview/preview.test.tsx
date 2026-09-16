import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, expect, test, vi } from 'vitest'
import App from '../src/App'
import pd3Mods from './fixtures/pd3/mods.json'
import pd3ModRecords from './fixtures/pd3/mod-records.json'

beforeAll(() => {
    const store = new Map<string, string>([
        ['modrex:active-game', 'pd3'],
        ['modrex:active-view', 'browse'],
    ])
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
    })
})

test('browse page renders the fixture listing without a backend', async () => {
    render(<App />)
    for (const mod of pd3Mods.data.slice(0, 3)) {
        expect(await screen.findByText(mod.name, {}, { timeout: 5000 })).toBeTruthy()
    }
})

test('opening a card renders the mod detail page', async () => {
    render(<App />)
    const first = pd3Mods.data[0]
    fireEvent.click(await screen.findByText(first.name, {}, { timeout: 5000 }))
    const record = pd3ModRecords[String(first.id) as keyof typeof pd3ModRecords]
    expect(await screen.findByText('Description', {}, { timeout: 5000 })).toBeTruthy()
    expect(await screen.findByText('Back')).toBeTruthy()
    expect((await screen.findAllByText(record.detail.user.name)).length).toBeGreaterThan(1)
})

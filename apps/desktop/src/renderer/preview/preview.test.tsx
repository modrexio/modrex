import { render, screen } from '@testing-library/react'
import { beforeAll, expect, test, vi } from 'vitest'
import App from '../src/App'
import pd3Mods from './fixtures/pd3/mods.json'

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

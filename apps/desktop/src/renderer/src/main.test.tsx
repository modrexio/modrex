// @vitest-environment happy-dom
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UpdatedNotice } from './api'

const mocks = vi.hoisted(() => ({
    nightly: false,
    gate: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }))
vi.mock('./appVersion', () => ({
    get isNightlyBuild() {
        return mocks.nightly
    },
}))
vi.mock('./api', () => ({ api: { waitForStartupGate: mocks.gate } }))
vi.mock('./App', () => ({
    default: ({ updated }: { updated: UpdatedNotice | null }) => (
        <p>{updated ? 'app updated to ' + updated.version : 'app'}</p>
    ),
}))

beforeEach(() => {
    vi.resetModules()
    mocks.gate.mockReset()
    document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
    cleanup()
})

async function load() {
    await act(async () => {
        await import('./main')
    })
}

test('a stable build renders at once and never asks for the gate', async () => {
    mocks.nightly = false
    await load()
    expect(screen.getByText('app')).toBeTruthy()
    expect(mocks.gate).not.toHaveBeenCalled()
})

test('a nightly build renders only once the gate opens, with its notice', async () => {
    mocks.nightly = true
    let open!: (notice: UpdatedNotice | null) => void
    mocks.gate.mockReturnValue(new Promise((resolve) => (open = resolve)))
    await load()
    expect(screen.queryByText(/app/)).toBeNull()
    await act(async () => open({ version: '0.17.0-nightly.20261108.1', releaseUrl: 'url' }))
    expect(screen.getByText('app updated to 0.17.0-nightly.20261108.1')).toBeTruthy()
})

test('a nightly build still renders when the gate request fails', async () => {
    mocks.nightly = true
    mocks.gate.mockRejectedValue(new Error('ipc down'))
    await load()
    expect(screen.getByText('app')).toBeTruthy()
})

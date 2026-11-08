// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { StartupPhase } from './api'

type Listener<T> = (payload: T) => void

const mocks = vi.hoisted(() => ({
    phase: undefined as Listener<StartupPhase> | undefined,
    progress: undefined as Listener<number> | undefined,
    ready: undefined as (() => void) | undefined,
    snapshot: undefined as ((phase: StartupPhase) => void) | undefined,
    finishStartup: vi.fn(),
    skipStartupUpdate: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }))
vi.mock('./api', () => ({
    api: {
        listenStartupProgress: (callback: Listener<StartupPhase>) => {
            mocks.phase = callback
            return Promise.resolve(() => {})
        },
        getStartupPhase: () =>
            new Promise<StartupPhase>((resolve) => {
                mocks.snapshot = resolve
            }),
        onUpdateProgress: (callback: Listener<number>) => {
            mocks.progress = callback
            return () => {}
        },
        onUpdateReady: (callback: () => void) => {
            mocks.ready = callback
            return () => {}
        },
        finishStartup: mocks.finishStartup,
        skipStartupUpdate: mocks.skipStartupUpdate,
    },
}))

const splash = () => document.querySelector<HTMLElement>('.splash')!
const button = () => document.getElementById('recovery') as HTMLButtonElement
const percentage = () => document.getElementById('percentage')!.textContent

beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.finishStartup.mockReset().mockResolvedValue(undefined)
    mocks.skipStartupUpdate.mockReset().mockResolvedValue(undefined)
    document.body.innerHTML = `
        <main class="splash">
            <p id="version"></p>
            <button id="recovery" type="button"></button>
            <div id="progress-bar"></div>
            <span id="status"></span>
            <span id="percentage">20%</span>
        </main>`
    await import('./splash')
    await vi.advanceTimersByTimeAsync(0)
})

afterEach(() => {
    vi.useRealTimers()
})

async function snapshot(phase: StartupPhase) {
    mocks.snapshot!(phase)
    await vi.advanceTimersByTimeAsync(0)
}

test('a snapshot older than a pushed phase does not overwrite it', async () => {
    mocks.phase!('updating')
    await snapshot('prepare')
    expect(splash().dataset.status).toBe('updating')
})

test('the snapshot is shown when nothing was pushed before it', async () => {
    await snapshot('interface')
    expect(splash().dataset.status).toBe('interface')
})

test('updating shows its own percent and offers the button only after two seconds', async () => {
    mocks.phase!('updating')
    expect(percentage()).toBe('0%')
    mocks.progress!(40)
    expect(percentage()).toBe('40%')
    await vi.advanceTimersByTimeAsync(1999)
    expect('skippable' in splash().dataset).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect('skippable' in splash().dataset).toBe(true)
})

test('a repeated updating phase does not restart the bar or the timer', async () => {
    mocks.phase!('updating')
    mocks.progress!(40)
    await vi.advanceTimersByTimeAsync(1500)
    mocks.phase!('updating')
    expect(percentage()).toBe('40%')
    await vi.advanceTimersByTimeAsync(500)
    expect('skippable' in splash().dataset).toBe(true)
})

test('the button skips the update while updating instead of opening Modrex', async () => {
    mocks.phase!('updating')
    await vi.advanceTimersByTimeAsync(2000)
    button().click()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.skipStartupUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.finishStartup).not.toHaveBeenCalled()
})

test('the installer handoff hides the button', async () => {
    mocks.phase!('updating')
    await vi.advanceTimersByTimeAsync(2000)
    mocks.ready!()
    expect('skippable' in splash().dataset).toBe(false)
})

test('an updating snapshot after the installer handoff does not offer the button', async () => {
    mocks.ready!()
    await snapshot('updating')
    await vi.advanceTimersByTimeAsync(2000)
    expect(splash().dataset.status).toBe('updating')
    expect('skippable' in splash().dataset).toBe(false)
})

test('progress outside updating does not move the bar', async () => {
    mocks.phase!('interface')
    mocks.progress!(90)
    expect(percentage()).toBe('40%')
})

test('leaving updating hides the button and resumes the phase bar', async () => {
    mocks.phase!('updating')
    await vi.advanceTimersByTimeAsync(2000)
    mocks.phase!('prepare')
    expect('skippable' in splash().dataset).toBe(false)
    expect(percentage()).toBe('20%')
    expect(button().disabled).toBe(false)
})

test('ready opens Modrex', async () => {
    mocks.phase!('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.finishStartup).toHaveBeenCalledTimes(1)
})

test('the recovery button still opens Modrex after an error', async () => {
    mocks.phase!('error')
    button().click()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.finishStartup).toHaveBeenCalledTimes(1)
    expect(mocks.skipStartupUpdate).not.toHaveBeenCalled()
})

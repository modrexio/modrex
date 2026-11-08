import { error as logError } from '@tauri-apps/plugin-log'
import { api, type StartupPhase } from './api'
import { getLocale, t, type StringKey } from './i18n'
import { initAccentColor } from './accentColor'
import { initCornerScale } from './cornerRadius'

initAccentColor()
initCornerScale()

// Updating shows the download's own percent instead of a step in this list.
const phases: Exclude<StartupPhase, 'error' | 'updating'>[] = [
    'prepare',
    'interface',
    'game',
    'mods',
    'ready',
]

const labels: Record<StartupPhase, StringKey> = {
    prepare: 'splash.prepare',
    updating: 'splash.updating',
    interface: 'splash.interface',
    game: 'splash.game',
    mods: 'splash.mods',
    ready: 'splash.ready',
    error: 'splash.error',
}

const splash = document.querySelector<HTMLElement>('.splash')!
const status = document.getElementById('status')!
const percentage = document.getElementById('percentage')!
const progress = document.getElementById('progress-bar')!
const recovery = document.getElementById('recovery') as HTMLButtonElement
const version = document.getElementById('version')!
let opening = false
// How long an update on open runs before the splash offers to open Modrex without it.
const SKIP_DELAY_MS = 2000
let skipTimer: ReturnType<typeof setTimeout> | undefined
// Set when the installer takes over, which can happen before the phase snapshot
// arrives. From then on a skip cannot stop it, so the button stays hidden.
let installing = false

version.textContent = 'VERSION ' + import.meta.env.VITE_APP_VERSION
document.title = t('splash.title')
document.documentElement.lang = getLocale()
recovery.textContent = t('splash.open')

async function openModrex() {
    if (opening) return
    opening = true
    recovery.disabled = true
    try {
        await api.finishStartup()
    } catch {
        opening = false
        recovery.disabled = false
        renderPhase('error')
    }
}

async function skipUpdate() {
    recovery.disabled = true
    try {
        await api.skipStartupUpdate()
    } catch (error) {
        void logError('Skipping the update on open failed: ' + String(error))
        recovery.disabled = false
    }
}

function renderProgress(percent: number) {
    progress.style.transform = 'scaleX(' + percent / 100 + ')'
    percentage.textContent = percent + '%'
}

function hideSkip() {
    clearTimeout(skipTimer)
    skipTimer = undefined
    delete splash.dataset.skippable
}

function renderPhase(phase: StartupPhase) {
    // The pushed event and the snapshot can both deliver updating, and the second must not
    // restart the bar or the button timer.
    const entering = splash.dataset.status !== phase
    status.textContent = t(labels[phase])
    splash.dataset.status = phase

    if (phase === 'updating') {
        if (!entering) return
        renderProgress(0)
        if (installing) return
        skipTimer = setTimeout(() => (splash.dataset.skippable = ''), SKIP_DELAY_MS)
        return
    }
    hideSkip()
    // A skip disables the button, and any later phase hands it back to openModrex.
    recovery.disabled = opening

    if (phase === 'error') return

    const currentIndex = phases.indexOf(phase)
    renderProgress(((currentIndex + 1) / phases.length) * 100)

    if (phase === 'ready') {
        void openModrex()
    }
}

async function start() {
    let pushed = false
    const stopListening = await api.listenStartupProgress((phase) => {
        pushed = true
        renderPhase(phase)
    })
    window.addEventListener('beforeunload', stopListening)
    const snapshot = await api.getStartupPhase()
    if (!pushed) renderPhase(snapshot)
}

// A download that continues after the splash stops waiting must not move the bar.
const stopProgress = api.onUpdateProgress((percent) => {
    if (splash.dataset.status === 'updating') renderProgress(percent)
})
const stopReady = api.onUpdateReady(() => {
    installing = true
    hideSkip()
})
window.addEventListener('beforeunload', () => {
    stopProgress()
    stopReady()
})
recovery.addEventListener('click', () => {
    if (splash.dataset.status === 'updating') void skipUpdate()
    else void openModrex()
})
start().catch((error) => {
    void logError('Splash startup failed: ' + String(error))
    renderPhase('error')
})

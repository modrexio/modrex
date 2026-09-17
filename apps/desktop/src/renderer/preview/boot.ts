import {
    DEFAULT_PREVIEW_STATE,
    GAME_STATES,
    LIBRARY_PROFILES,
    NETWORK_MODES,
    ONBOARDING_STATES,
    previewState,
} from './previewState'

if (previewState.onboarding === 'first-run') {
    for (const key of Object.keys(localStorage)) {
        if (key.startsWith('modrex:')) localStorage.removeItem(key)
    }
}

const panel = document.createElement('div')
panel.title = 'Preview state'
panel.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:9999;display:grid;gap:4px;font:12px system-ui;padding:8px;border-radius:6px;background:#1e1e1e;color:#ddd;border:1px solid #444;opacity:.85'

function addPicker(
    name: string,
    labelText: string,
    options: Record<string, string>,
    current: string,
    defaultValue: string
) {
    const label = document.createElement('label')
    label.textContent = labelText
    label.style.cssText = 'display:grid;grid-template-columns:72px 1fr;align-items:center;gap:6px'

    const picker = document.createElement('select')
    picker.title = `Preview ${name}`
    picker.style.cssText =
        'max-width:260px;padding:3px 5px;border-radius:4px;background:#282828;color:#ddd;border:1px solid #555'
    for (const [value, description] of Object.entries(options)) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = `${value}: ${description}`
        option.selected = value === current
        picker.append(option)
    }
    picker.addEventListener('change', () => {
        const url = new URL(window.location.href)
        url.searchParams.delete('scenario')
        if (picker.value === defaultValue) url.searchParams.delete(name)
        else url.searchParams.set(name, picker.value)
        window.location.assign(url)
    })
    label.append(picker)
    panel.append(label)
}

addPicker(
    'library',
    'Library',
    LIBRARY_PROFILES,
    previewState.library,
    DEFAULT_PREVIEW_STATE.library
)
addPicker('network', 'Network', NETWORK_MODES, previewState.network, DEFAULT_PREVIEW_STATE.network)
addPicker('games', 'Games', GAME_STATES, previewState.games, DEFAULT_PREVIEW_STATE.games)
addPicker(
    'onboarding',
    'Onboarding',
    ONBOARDING_STATES,
    previewState.onboarding,
    DEFAULT_PREVIEW_STATE.onboarding
)
document.body.append(panel)

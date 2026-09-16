import { SCENARIOS, scenario } from './scenario'

const current = scenario()

if (current === 'first-run') {
    for (const key of Object.keys(localStorage)) {
        if (key.startsWith('modrex:')) localStorage.removeItem(key)
    }
}

const picker = document.createElement('select')
picker.title = 'Preview scenario'
picker.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:9999;font:12px system-ui;padding:4px 6px;border-radius:6px;background:#1e1e1e;color:#ddd;border:1px solid #444;opacity:.7'
for (const [name, description] of Object.entries(SCENARIOS)) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = `${name}: ${description}`
    option.selected = name === current
    picker.append(option)
}
picker.addEventListener('change', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('scenario', picker.value)
    window.location.assign(url)
})
document.body.append(picker)

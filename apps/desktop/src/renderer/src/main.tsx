import ReactDOM from 'react-dom/client'
import { error as logError } from '@tauri-apps/plugin-log'
import App from './App'
import { api, type UpdatedNotice } from './api'
import { isNightlyBuild } from './appVersion'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initAccentColor } from './accentColor'
import { initCornerScale } from './cornerRadius'
import './index.css'

initAccentColor()
initCornerScale()

window.onerror = (_msg, _src, _line, _col, err) => {
    logError(`Uncaught error: ${err?.stack ?? err}`)
}

window.onunhandledrejection = (event) => {
    logError(`Unhandled rejection: ${event.reason?.stack ?? event.reason}`)
}

function renderApp(updated: UpdatedNotice | null) {
    ReactDOM.createRoot(document.getElementById('root')!).render(
        <ErrorBoundary>
            <App updated={updated} />
        </ErrorBoundary>
    )
}

// A nightly build may install an update before the app starts, so it renders only once Rust
// opens the gate. Rust owns every deadline. A failed request renders anyway, and the first
// phase report then revokes the install.
if (isNightlyBuild) {
    api.waitForStartupGate().then(renderApp, (error) => {
        void logError('Startup gate failed: ' + String(error))
        renderApp(null)
    })
} else {
    renderApp(null)
}

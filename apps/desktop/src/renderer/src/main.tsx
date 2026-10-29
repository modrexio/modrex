import ReactDOM from 'react-dom/client'
import { error as logError } from '@tauri-apps/plugin-log'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initAccentColor } from './accentColor'
import { initCornerRadius } from './cornerRadius'
import './index.css'

initAccentColor()
initCornerRadius()

window.onerror = (_msg, _src, _line, _col, err) => {
    logError(`Uncaught error: ${err?.stack ?? err}`)
}

window.onunhandledrejection = (event) => {
    logError(`Unhandled rejection: ${event.reason?.stack ?? event.reason}`)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
)

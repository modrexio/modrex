import ReactDOM from 'react-dom/client'
import { error as logError } from '@tauri-apps/plugin-log'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTheme } from './theme'
import './index.css'

initTheme()

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

import { Component, type ReactNode } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { X } from 'lucide-react'
import { api } from '../api'
import { Button } from './ui/Button'
import { ScrollArea } from './ScrollArea'
import { t } from '../i18n'

interface Props {
    children: ReactNode
}

interface State {
    error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: { componentStack: string }) {
        logError(`React error: ${error.message}\n${info.componentStack}`)
    }

    render() {
        if (this.state.error) {
            // The window is undecorated, so this fallback replaces the custom title
            // bar too, so it must provide its own drag region and close button or a
            // crash leaves the window impossible to move or close.
            return (
                <div className="flex flex-col h-screen text-text-subtle">
                    <div
                        data-tauri-drag-region
                        className="shrink-0 h-10 flex items-center justify-end border-b border-border"
                    >
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('errorBoundary.close')}
                            onClick={() => api.windowClose()}
                            className="h-10 w-11 rounded-none hover:bg-danger hover:text-text"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>
                    <div className="flex flex-col items-center justify-center flex-1 gap-4">
                        <p className="text-sm">{t('errorBoundary.message')}</p>
                        <ScrollArea hostClassName="max-w-lg" className="overflow-auto">
                            <pre className="text-xs text-danger-text">
                                {this.state.error.message}
                            </pre>
                        </ScrollArea>
                    </div>
                </div>
            )
        }
        return this.props.children
    }
}

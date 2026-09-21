import type { ReactNode } from 'react'
import { X, RefreshCw } from 'lucide-react'
import { Button } from './ui/Button'
import { WindowControls } from './WindowControls'
import { Tooltip } from './Tooltip'
import { t } from '../i18n'
import { api } from '../api'

export interface TopBarProps {
    update?: { phase: 'downloading' | 'ready'; percent: number | null } | null
    onDismissUpdate?: () => void
}

export function TopBar({
    update,
    onDismissUpdate,
    children,
}: TopBarProps & { children?: ReactNode }) {
    return (
        <>
            {/* z-[60] keeps the title bar above the startup splash (z-50) and Radix
                dialog overlays (z-50); pointer-events-auto re-enables it under Radix's
                modal body pointer-events lock, so the window stays draggable and
                closable during startup and while any modal is open. */}
            <div className="shrink-0 bg-surface border-b border-border relative z-[60] pointer-events-auto">
                <div data-tauri-drag-region className="h-10 flex items-center justify-between pl-4">
                    <div className="flex items-end gap-2 pointer-events-none">
                        <span
                            style={{
                                fontFamily: "'Bebas Neue', sans-serif",
                                fontSize: '1.375rem',
                                letterSpacing: '0.05em',
                                lineHeight: 1,
                            }}
                        >
                            <span style={{ color: 'var(--color-text)' }}>MOD</span>
                            <span style={{ color: 'var(--color-accent)' }}>REX</span>
                        </span>
                        <span
                            className="text-xs text-text-subtle"
                            style={{ marginBottom: '0.3rem' }}
                        >
                            {import.meta.env.DEV ? 'v-dev' : `v${import.meta.env.VITE_APP_VERSION}`}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 h-full">
                        {update?.phase === 'ready' && (
                            <>
                                <button
                                    onClick={() => api.installUpdate()}
                                    className="text-xs px-3 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors flex items-center gap-1.5"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    {t('app.updateInstall')}
                                </button>
                                <Tooltip content={t('common.dismiss')}>
                                    <Button variant="ghost" size="icon" onClick={onDismissUpdate}>
                                        <X className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                                <div className="w-px h-4 bg-border mx-1" />
                            </>
                        )}
                        {children}
                        <div className="w-px h-4 bg-border ml-1" />
                        <WindowControls />
                    </div>
                </div>
                {update?.phase === 'downloading' && (
                    <div className="h-0.5 bg-surface-hover">
                        <div
                            className="h-full bg-accent transition-all duration-300"
                            style={{ width: `${update.percent ?? 0}%` }}
                        />
                    </div>
                )}
            </div>
        </>
    )
}

import { useState } from 'react'
import {
    Compass,
    Package,
    Newspaper,
    Settings,
    ArrowLeft,
    ChevronLeft,
    CircleHelp,
} from 'lucide-react'
import { siDiscord } from 'simple-icons'
import { api } from '../api'
import type { ComponentType } from 'react'
import { t } from '../i18n'
import type { StringKey } from '../i18n'
import type { GameId } from '../../../shared/types'
import { GAMES } from '../../../shared/types'
import { Tooltip } from './Tooltip'

type NavView = 'browse' | 'installed' | 'news' | 'settings'

interface Props {
    navigation:
        | { kind: 'global'; view: 'picker' | 'settings'; onViewChange: (view: 'settings') => void }
        | { kind: 'game'; view: NavView; activeGame: GameId; onViewChange: (view: NavView) => void }
    onShowWelcome: () => void
}

const navItems: {
    id: NavView
    labelKey: StringKey
    icon: ComponentType<{ className?: string }>
}[] = [
    { id: 'browse', labelKey: 'sidebar.browse', icon: Compass },
    { id: 'installed', labelKey: 'sidebar.installed', icon: Package },
    { id: 'news', labelKey: 'sidebar.news', icon: Newspaper },
]

export function Sidebar({ navigation, onShowWelcome }: Props) {
    const [collapsed, setCollapsed] = useState(
        () => localStorage.getItem('modrex:sidebar-collapsed') === 'true'
    )

    return (
        <aside
            className={`${collapsed ? 'w-12' : 'w-48'} shrink-0 flex flex-col bg-surface-raised border-r border-border transition-[width] duration-200 overflow-hidden`}
        >
            {navigation.kind === 'game' ? (
                <div className="p-2 border-b border-border shrink-0">
                    <Tooltip
                        content={`${GAMES[navigation.activeGame].name} - ${t('sidebar.changeGame')}`}
                        side="right"
                    >
                        <button
                            onClick={onShowWelcome}
                            className="w-full px-2 py-1.5 gap-2 flex items-center rounded text-xs hover:bg-surface-hover text-text hover:text-text transition-colors"
                        >
                            <ArrowLeft className="w-3.5 h-3.5 shrink-0 text-text-subtle" />
                            <span
                                className={`truncate transition-opacity duration-200 font-medium flex-1 text-left ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                            >
                                {GAMES[navigation.activeGame].name}
                            </span>
                        </button>
                    </Tooltip>
                </div>
            ) : navigation.view === 'settings' ? (
                <div className="p-2 border-b border-border shrink-0">
                    <Tooltip content={t('sidebar.back')} disabled={!collapsed} side="right">
                        <button
                            onClick={onShowWelcome}
                            className="w-full px-2 py-1.5 gap-2 flex items-center rounded text-xs hover:bg-surface-hover text-text-muted hover:text-text transition-colors"
                        >
                            <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                            <span
                                className={`truncate transition-opacity duration-200 font-medium flex-1 text-left ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                            >
                                {t('sidebar.back')}
                            </span>
                        </button>
                    </Tooltip>
                </div>
            ) : null}

            <nav className="flex flex-col gap-1 p-2 flex-1">
                {navigation.kind === 'game' &&
                    navItems
                        .filter(
                            (item) => item.id !== 'news' || GAMES[navigation.activeGame].hasNews
                        )
                        .map((item) => {
                            const Icon = item.icon
                            return (
                                <Tooltip
                                    key={item.id}
                                    content={t(item.labelKey)}
                                    disabled={!collapsed}
                                    side="right"
                                >
                                    <button
                                        onClick={() => navigation.onViewChange(item.id)}
                                        className={`w-full px-2 py-2 gap-2.5 flex items-center rounded text-sm transition-colors ${
                                            navigation.view === item.id
                                                ? 'bg-surface-active text-text'
                                                : 'text-text-muted hover:bg-surface-hover hover:text-text'
                                        }`}
                                    >
                                        <Icon className="w-4 h-4 shrink-0" />
                                        <span
                                            className={`truncate transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                                        >
                                            {t(item.labelKey)}
                                        </span>
                                    </button>
                                </Tooltip>
                            )
                        })}
            </nav>

            <div className="p-2 flex flex-col gap-1">
                <Tooltip content={t('sidebar.settings')} disabled={!collapsed} side="right">
                    <button
                        onClick={() => navigation.onViewChange('settings')}
                        className={`w-full px-2 py-2 gap-2.5 flex items-center rounded text-sm transition-colors ${
                            navigation.view === 'settings'
                                ? 'bg-surface-active text-text'
                                : 'text-text-muted hover:bg-surface-hover hover:text-text'
                        }`}
                    >
                        <Settings className="w-4 h-4 shrink-0" />
                        <span
                            className={`truncate transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                        >
                            {t('sidebar.settings')}
                        </span>
                    </button>
                </Tooltip>
                <Tooltip content={t('sidebar.discordTitle')} side="right">
                    <button
                        onClick={() => api.openExternal('https://discord.gg/QM2rDgy43Y')}
                        className="w-full px-2 py-2 gap-2.5 flex items-center rounded text-sm text-text-muted hover:bg-surface-hover hover:text-text transition-colors"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            className="w-4 h-4 shrink-0 fill-current"
                            aria-hidden
                        >
                            <path d={siDiscord.path} />
                        </svg>
                        <span
                            className={`truncate transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                        >
                            {t('sidebar.discord')}
                        </span>
                    </button>
                </Tooltip>
                <Tooltip content={t('sidebar.docsTitle')} side="right">
                    <button
                        onClick={() => api.openExternal('https://modrex.net/docs/')}
                        className="w-full px-2 py-2 gap-2.5 flex items-center rounded text-sm text-text-muted hover:bg-surface-hover hover:text-text transition-colors"
                    >
                        <CircleHelp className="w-4 h-4 shrink-0" />
                        <span
                            className={`truncate transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                        >
                            {t('sidebar.docs')}
                        </span>
                    </button>
                </Tooltip>
            </div>

            <div className="p-2 border-t border-border">
                <Tooltip
                    content={collapsed ? t('sidebar.expandTitle') : t('sidebar.collapseTitle')}
                    side="right"
                >
                    <button
                        onClick={() =>
                            setCollapsed((c) => {
                                localStorage.setItem('modrex:sidebar-collapsed', String(!c))
                                return !c
                            })
                        }
                        className="w-full px-2 py-1.5 gap-2.5 flex items-center rounded text-xs text-text-subtle hover:bg-surface-hover hover:text-text transition-colors"
                    >
                        <ChevronLeft
                            className={`w-4 h-4 shrink-0 transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
                        />
                        <span
                            className={`truncate transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
                        >
                            {t('sidebar.collapse')}
                        </span>
                    </button>
                </Tooltip>
            </div>
        </aside>
    )
}

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { FolderOpen } from 'lucide-react'
import { t } from '../i18n'
import { Button } from './ui/Button'
import { Tooltip } from './Tooltip'
import { HeaderTab } from './HeaderTab'
import { TITLE_ROW_H } from './pageHeader'
import { GAME_FILES_TAB } from '../hooks/installedTabs'

export interface InstalledTab {
    key: string
    label: string
    count: number
    hasProblem: boolean
}

export function installedTabId(baseId: string, key: string): string {
    return `${baseId}-tab-${key}`
}

export function installedTabPanelId(baseId: string): string {
    return `${baseId}-panel`
}

interface Props {
    baseId: string
    tabs: InstalledTab[]
    activeKey: string
    onSelect: (key: string) => void
    onOpenFolder: (key: string) => void
}

function nextTabIndex(key: string, index: number, count: number): number | null {
    if (key === 'ArrowRight') return (index + 1) % count
    if (key === 'ArrowLeft') return (index - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return null
}

export function InstalledTabBar({ baseId, tabs, activeKey, onSelect, onOpenFolder }: Props) {
    const tablistRef = useRef<HTMLDivElement>(null)
    const [maskImage, setMaskImage] = useState<string>()

    useLayoutEffect(() => {
        document.getElementById(installedTabId(baseId, activeKey))!.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
        })
    }, [activeKey, baseId])

    useLayoutEffect(() => {
        const tablist = tablistRef.current!
        function updateOverflow() {
            const left = tablist.scrollLeft > 1
            const right = tablist.scrollLeft + tablist.clientWidth < tablist.scrollWidth - 1
            setMaskImage(
                left || right
                    ? `linear-gradient(to right, ${left ? 'transparent' : 'var(--color-text)'}, var(--color-text) 32px, var(--color-text) calc(100% - 32px), ${right ? 'transparent' : 'var(--color-text)'})`
                    : undefined
            )
        }
        // The scrollbar is hidden, so a vertical wheel scrolls the tabs sideways. Without this,
        // only shift and wheel or the keyboard could reach a tab cut off at a narrow width.
        function scrollSideways(e: WheelEvent) {
            if (tablist.scrollWidth <= tablist.clientWidth) return
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
            e.preventDefault()
            tablist.scrollLeft += e.deltaY
        }
        const observer = new ResizeObserver(updateOverflow)
        observer.observe(tablist)
        for (const tab of tablist.children) observer.observe(tab)
        tablist.addEventListener('scroll', updateOverflow)
        tablist.addEventListener('wheel', scrollSideways, { passive: false })
        updateOverflow()
        return () => {
            observer.disconnect()
            tablist.removeEventListener('scroll', updateOverflow)
            tablist.removeEventListener('wheel', scrollSideways)
        }
    }, [tabs])

    function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
        const next = nextTabIndex(e.key, index, tabs.length)
        if (next === null) return
        e.preventDefault()
        onSelect(tabs[next].key)
        document.getElementById(installedTabId(baseId, tabs[next].key))?.focus()
    }

    return (
        <div
            ref={tablistRef}
            role="tablist"
            aria-label={t('installed.tabs.label')}
            // A visible scrollbar would take height from the fixed title row. The edge fade
            // shows that more tabs exist.
            className={`flex items-stretch gap-1 min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>div]:h-full ${TITLE_ROW_H}`}
            style={{ maskImage }}
        >
            {tabs.map((tab, index) => {
                const active = tab.key === activeKey
                const openFolderLabel = t('installed.tabs.openFolder', { name: tab.label })
                return (
                    <HeaderTab
                        key={tab.key}
                        compact
                        className="focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                        active={active}
                        role="tab"
                        id={installedTabId(baseId, tab.key)}
                        aria-selected={active}
                        aria-controls={installedTabPanelId(baseId)}
                        tabIndex={active ? 0 : -1}
                        onClick={() => onSelect(tab.key)}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                        label={
                            <>
                                {tab.label}
                                {tab.hasProblem && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-warning">
                                        <span className="sr-only">
                                            {t('installed.tabs.hasProblems')}
                                        </span>
                                    </span>
                                )}
                            </>
                        }
                        count={t(
                            tab.count === 1 ? 'installed.modCountSingle' : 'installed.modCount',
                            { count: tab.count }
                        )}
                        action={
                            active &&
                            tab.key !== GAME_FILES_TAB && (
                                <Tooltip content={openFolderLabel}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={openFolderLabel}
                                        onClick={() => onOpenFolder(tab.key)}
                                        className="hover:bg-transparent focus-visible:ring-2 focus-visible:ring-accent/60"
                                    >
                                        <FolderOpen className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                            )
                        }
                    />
                )
            })}
        </div>
    )
}

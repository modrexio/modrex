// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { GAME_FILES_TAB } from '../hooks/installedTabs'

vi.mock('./Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
}))

import {
    InstalledTabBar,
    installedTabId,
    installedTabPanelId,
    type InstalledTab,
} from './InstalledTabBar'

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

const TABS: InstalledTab[] = [
    { key: 'paks', label: 'Pak mods', count: 3, hasProblem: false },
    { key: 'ue4ss_mods', label: 'UE4SS mods', count: 1, hasProblem: true },
    { key: GAME_FILES_TAB, label: 'Game files', count: 2, hasProblem: false },
]

function Harness({ onOpenFolder = vi.fn() }: { onOpenFolder?: (key: string) => void }) {
    const [active, setActive] = useState('paks')
    return (
        <>
            <InstalledTabBar
                baseId="t"
                tabs={TABS}
                activeKey={active}
                onSelect={setActive}
                onOpenFolder={onOpenFolder}
            />
            <div role="tabpanel" id={installedTabPanelId('t')} />
        </>
    )
}

function selected(): string | null {
    return screen.getByRole('tab', { selected: true }).id
}

describe('InstalledTabBar', () => {
    it('wires every tab to the panel and puts the folder action in the active tab', () => {
        render(<Harness />)
        const tabs = screen.getAllByRole('tab')
        for (const tab of tabs) {
            expect(tab.getAttribute('aria-controls')).toBe(installedTabPanelId('t'))
        }
        const active = screen.getByRole('tab', { selected: true })
        const folder = screen.getByLabelText('Open Pak mods folder')
        expect(active.parentElement?.contains(folder)).toBe(true)
        expect(active.contains(folder)).toBe(false)
        expect(screen.getAllByRole('button')).toHaveLength(1)
        for (const tab of tabs) expect(tab.tabIndex).toBe(tab === active ? 0 : -1)
    })

    it('moves between tabs with the arrow, Home and End keys', () => {
        render(<Harness />)
        const first = screen.getByRole('tab', { selected: true })
        fireEvent.keyDown(first, { key: 'ArrowLeft' })
        expect(selected()).toBe(installedTabId('t', GAME_FILES_TAB))
        expect(first.tabIndex).toBe(-1)
        expect(screen.getByRole('tab', { selected: true }).tabIndex).toBe(0)
        expect(document.activeElement?.id).toBe(installedTabId('t', GAME_FILES_TAB))
        fireEvent.keyDown(document.activeElement!, { key: 'Home' })
        expect(selected()).toBe(installedTabId('t', 'paks'))
        fireEvent.keyDown(document.activeElement!, { key: 'End' })
        expect(selected()).toBe(installedTabId('t', GAME_FILES_TAB))
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
        expect(selected()).toBe(installedTabId('t', 'paks'))
    })

    it('scrolls the active tab into view on mount, click and keyboard selection', () => {
        render(<Harness />)
        const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
        const expectActiveScrolled = () => {
            expect(scrollIntoView.mock.instances.at(-1)).toBe(
                screen.getByRole('tab', { selected: true })
            )
            expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
        }
        expectActiveScrolled()
        fireEvent.click(screen.getByRole('tab', { name: /UE4SS mods/ }))
        expectActiveScrolled()
        fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'End' })
        expectActiveScrolled()
        expect(scrollIntoView).toHaveBeenCalledTimes(3)
    })

    it('fades only overflowing edges on scroll and resize and cleans up on unmount', () => {
        let resize!: () => void
        const disconnect = vi.fn()
        const observe = vi.fn()
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe = observe
                unobserve = vi.fn()
                disconnect = disconnect
                constructor(callback: ResizeObserverCallback) {
                    resize = () => callback([], this)
                }
            }
        )
        const { unmount } = render(<Harness />)
        const tablist = screen.getByRole('tablist')
        const removeListener = vi.spyOn(tablist, 'removeEventListener')
        Object.defineProperties(tablist, {
            clientWidth: { configurable: true, value: 200 },
            scrollWidth: { configurable: true, value: 500 },
        })
        expect(observe).toHaveBeenCalledWith(tablist)
        expect(observe).toHaveBeenCalledTimes(TABS.length + 1)
        expect(tablist.style.maskImage).toBe('')
        act(() => resize())
        expect(tablist.style.maskImage).toBe(
            'linear-gradient(to right, var(--color-text), var(--color-text) 32px, var(--color-text) calc(100% - 32px), transparent)'
        )
        tablist.scrollLeft = 100
        fireEvent.scroll(tablist)
        expect(tablist.style.maskImage).toBe(
            'linear-gradient(to right, transparent, var(--color-text) 32px, var(--color-text) calc(100% - 32px), transparent)'
        )
        tablist.scrollLeft = 300
        fireEvent.scroll(tablist)
        expect(tablist.style.maskImage).toBe(
            'linear-gradient(to right, transparent, var(--color-text) 32px, var(--color-text) calc(100% - 32px), var(--color-text))'
        )
        tablist.scrollLeft = 0
        Object.defineProperty(tablist, 'clientWidth', { value: 500 })
        act(() => resize())
        expect(tablist.style.maskImage).toBe('')
        unmount()
        expect(disconnect).toHaveBeenCalledOnce()
        expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    })

    it('shows localized counts below the labels and keeps the problem dot on the label line', () => {
        render(<Harness />)
        const pak = screen.getByRole('tab', { name: /Pak mods/ })
        const ue4ss = screen.getByRole('tab', { name: /UE4SS mods/ })
        expect(within(pak).getByText('3 mods').previousElementSibling?.textContent).toBe('Pak mods')
        expect(within(ue4ss).getByText('1 mod')).toBeTruthy()
        expect(
            within(ue4ss).getByText('Needs attention').closest('.bg-warning')?.parentElement
                ?.textContent
        ).toBe('UE4SS modsNeeds attention')
        expect(pak.classList.contains('border-accent')).toBe(true)
        expect(ue4ss.classList.contains('border-transparent')).toBe(true)
    })

    it('opens the active location and offers no folder for game files', () => {
        const onOpenFolder = vi.fn()
        render(<Harness onOpenFolder={onOpenFolder} />)
        fireEvent.click(screen.getByLabelText('Open Pak mods folder'))
        expect(onOpenFolder).toHaveBeenCalledWith('paks')
        fireEvent.click(screen.getByRole('tab', { name: /UE4SS mods/ }))
        expect(screen.queryByLabelText('Open Pak mods folder')).toBeNull()
        fireEvent.click(screen.getByLabelText('Open UE4SS mods folder'))
        expect(onOpenFolder).toHaveBeenLastCalledWith('ue4ss_mods')
        fireEvent.click(screen.getByRole('tab', { name: /Game files/ }))
        expect(screen.queryByLabelText('Open Game files folder')).toBeNull()
    })
})

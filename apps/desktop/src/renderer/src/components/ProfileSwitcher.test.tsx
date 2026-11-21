// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProfileList } from '../api'
import type { Profiles } from '../hooks/useProfiles'
import { ProfileSwitcher } from './ProfileSwitcher'
import { TooltipProvider } from './Tooltip'

function profiles(list: ProfileList): Profiles {
    return {
        list,
        switching: null,
        error: null,
        clearError: vi.fn(),
        switchTo: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(true),
        rename: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(undefined),
        dismissPending: vi.fn().mockResolvedValue(undefined),
        imported: vi.fn().mockResolvedValue(undefined),
    }
}

const two: ProfileList = {
    profiles: [
        { id: 'p1', name: 'Heists' },
        { id: 'p2', name: 'Vanilla plus' },
    ],
    active: 'p1',
    unfinishedSwitch: null,
    loaders: [],
    pending: [],
}

function show(state: Profiles) {
    render(
        <TooltipProvider>
            <ProfileSwitcher gameId="pd3" gamePath="C:/game" profiles={state} />
        </TooltipProvider>
    )
}

function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: /^Profiles: / }))
}

afterEach(cleanup)

describe('ProfileSwitcher', () => {
    it('offers sharing on each row, importing, and the shared mods still waiting', async () => {
        const waiting = {
            memberKey: 1,
            source: 'nexus' as const,
            modId: 27,
            fileId: 89,
            installedName: 'HUD.pak',
            reason: 'Waiting for a Nexus download',
            url: 'https://www.nexusmods.com/payday3/mods/27?tab=files&file_id=89&nmm=1',
        }
        show(profiles({ ...two, pending: [waiting] }))
        openMenu()
        expect(await screen.findByRole('button', { name: 'Share Heists' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Import profile' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Not downloaded: 1' })).toBeTruthy()
    })

    it('switches when another profile is picked and not when the active one is', async () => {
        const state = profiles(two)
        show(state)
        expect(screen.getByText('Heists')).toBeTruthy()

        openMenu()
        const active = await screen.findByRole('switch', { name: 'Switch to Heists' })
        expect(active.getAttribute('aria-checked')).toBe('true')
        fireEvent.click(active)
        expect(state.switchTo).not.toHaveBeenCalled()

        const other = screen.getByRole('switch', { name: 'Switch to Vanilla plus' })
        expect(other.getAttribute('aria-checked')).toBe('false')
        fireEvent.click(other)
        expect(state.switchTo).toHaveBeenCalledWith('p2')
    })

    // The explanation is read once, so with profiles listed it waits behind the info icon,
    // and only the empty menu spells it out.
    it('explains profiles inline only before the first one exists', async () => {
        // The text stays in the page while hidden, so it can animate closed.
        const shown = () =>
            screen
                .getByText(/Each profile has its own mods/)
                .closest('[aria-hidden]')!
                .getAttribute('aria-hidden') === 'false'
        show(
            profiles({
                profiles: [],
                active: null,
                unfinishedSwitch: null,
                loaders: [],
                pending: [],
            })
        )
        openMenu()
        await screen.findByText(/Each profile has its own mods/)
        expect(shown()).toBe(true)
        expect(screen.queryByRole('button', { name: 'About profiles' })).toBeNull()
        cleanup()

        show(profiles(two))
        openMenu()
        const about = await screen.findByRole('button', { name: 'About profiles' })
        expect(shown()).toBe(false)
        fireEvent.click(about)
        expect(shown()).toBe(true)
        expect(about.getAttribute('aria-expanded')).toBe('true')
        fireEvent.click(about)
        expect(shown()).toBe(false)
    })

    // A menu that vanishes on the click gives no sign the switch happened.
    it('stays open on a switch and shows the new profile on while it runs', async () => {
        const state = profiles(two)
        const view = render(
            <TooltipProvider>
                <ProfileSwitcher gameId="pd3" gamePath="C:/game" profiles={state} />
            </TooltipProvider>
        )
        openMenu()
        fireEvent.click(await screen.findByRole('switch', { name: 'Switch to Vanilla plus' }))
        expect(state.switchTo).toHaveBeenCalledWith('p2')

        view.rerender(
            <TooltipProvider>
                <ProfileSwitcher
                    gameId="pd3"
                    gamePath="C:/game"
                    profiles={{ ...state, switching: 'p2' }}
                />
            </TooltipProvider>
        )
        const target = screen.getByRole('switch', { name: 'Switch to Vanilla plus' })
        const left = screen.getByRole('switch', { name: 'Switch to Heists' })
        expect(target.getAttribute('aria-checked')).toBe('true')
        expect(left.getAttribute('aria-checked')).toBe('false')
        fireEvent.click(left)
        expect(state.switchTo).toHaveBeenCalledTimes(1)
    })

    it('lets the user go back to the active profile after a switch stopped', async () => {
        const state = profiles({ ...two, unfinishedSwitch: 'p2' })
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('switch', { name: 'Switch to Heists' }))

        expect(state.switchTo).toHaveBeenCalledWith('p1')
    })

    const pressSave = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // Enter submits the field's form, which a key event alone does not do in a test DOM.
    const enter = (field: HTMLElement) => fireEvent.submit(field.closest('form')!)
    const escape = (field: HTMLElement) => fireEvent.keyDown(field, { key: 'Escape' })

    it('saves the current setup as the first profile in the menu itself', async () => {
        const state = profiles({
            profiles: [],
            active: null,
            unfinishedSwitch: null,
            loaders: [],
            pending: [],
        })
        show(state)
        expect(screen.getByText('No profile')).toBeTruthy()

        openMenu()
        fireEvent.click(await screen.findByText('Save current setup as a profile'))
        const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
        expect(name.value).toBe('Main')
        pressSave()

        await waitFor(() => expect(state.create).toHaveBeenCalledWith('Main', { kind: 'current' }))
        expect(screen.queryByRole('dialog', { name: /Save current setup/ })).toBeNull()
    })

    it('starts a new profile empty from a name typed into the list', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByText('New profile'))
        const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
        expect(name.value).toBe('')
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            true
        )
        enter(name)
        expect(state.create).not.toHaveBeenCalled()
        fireEvent.change(name, { target: { value: ' Clean ' } })
        enter(name)

        await waitFor(() =>
            expect(state.create).toHaveBeenCalledWith('Clean', {
                kind: 'empty',
                keepLoaders: false,
            })
        )
    })

    it('offers to keep the installed loaders for a new profile, unchecked', async () => {
        const state = profiles({ ...two, loaders: ['PDML', 'UE4SS'] })
        show(state)

        openMenu()
        fireEvent.click(await screen.findByText('New profile'))
        const keep = screen.getByRole('checkbox', {
            name: 'Keep loaders: PDML, UE4SS',
        }) as HTMLInputElement
        expect(keep.checked).toBe(false)
        fireEvent.click(keep)
        fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
            target: { value: 'Modded' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() =>
            expect(state.create).toHaveBeenCalledWith('Modded', {
                kind: 'empty',
                keepLoaders: true,
            })
        )
    })

    it('asks nothing about loaders when none are installed', async () => {
        show(profiles(two))

        openMenu()
        fireEvent.click(await screen.findByText('New profile'))

        expect(screen.queryByRole('checkbox')).toBeNull()
    })

    it('duplicates a profile under a copy name the user can keep', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Vanilla plus' }))
        const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
        expect(name.value).toBe('Vanilla plus copy')
        pressSave()

        await waitFor(() =>
            expect(state.create).toHaveBeenCalledWith('Vanilla plus copy', {
                kind: 'copy',
                profileId: 'p2',
            })
        )
    })

    it('renames in the row and leaves the menu open', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Heists' }))
        const name = screen.getByRole('textbox', { name: 'Name' })
        fireEvent.change(name, { target: { value: 'Stealth' } })
        enter(name)

        await waitFor(() => expect(state.rename).toHaveBeenCalledWith('p1', 'Stealth'))
        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
        expect(screen.getByRole('switch', { name: 'Switch to Heists' })).toBeTruthy()
    })

    it('keeps the name field open when the change fails', async () => {
        const state = profiles(two)
        state.rename = vi.fn().mockResolvedValue(false)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Heists' }))
        const name = screen.getByRole('textbox', { name: 'Name' })
        fireEvent.change(name, { target: { value: 'Stealth' } })
        enter(name)

        await waitFor(() => expect(state.rename).toHaveBeenCalledWith('p1', 'Stealth'))
        expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Stealth')
    })

    // Escape inside an edit belongs to the edit, and only a second one closes the menu.
    it('cancels an edit on Escape without saving it or closing the menu', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Heists' }))
        const name = screen.getByRole('textbox', { name: 'Name' })
        fireEvent.change(name, { target: { value: 'Thrown away' } })
        escape(name)
        fireEvent.blur(name)

        expect(screen.queryByRole('textbox')).toBeNull()
        expect(screen.getByRole('switch', { name: 'Switch to Heists' })).toBeTruthy()
        expect(state.rename).not.toHaveBeenCalled()
    })

    // A copy nobody confirmed must not appear because the user clicked somewhere else.
    it('saves nothing when the user leaves a name field without confirming it', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Vanilla plus' }))
        const name = screen.getByRole('textbox', { name: 'Name' })
        fireEvent.blur(name)
        expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(screen.queryByRole('textbox')).toBeNull()
        expect(state.create).not.toHaveBeenCalled()
    })

    it('confirms a delete in a dialog that says what goes with the profile', async () => {
        const state = profiles(two)
        show(state)

        openMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Delete Heists' }))
        expect(await screen.findByText(/no profile is active afterwards/)).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(state.remove).toHaveBeenCalledWith('p1'))
    })
})

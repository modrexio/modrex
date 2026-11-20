import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import {
    Check,
    ChevronDown,
    Copy,
    Info,
    Layers,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    X,
} from 'lucide-react'
import type { ProfileSource, ProfileSummary } from '../api'
import type { Profiles } from '../hooks/useProfiles'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Toggle } from './Toggle'
import { Tooltip } from './Tooltip'
import { Button } from './ui/Button'

// A name is typed in the row it concerns, so the menu stays open around it.
type Editing =
    | { kind: 'rename'; id: string }
    | { kind: 'create'; source: ProfileSource; initial: string }

interface Props {
    profiles: Profiles
}

export function ProfileSwitcher({ profiles }: Props) {
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState<Editing | null>(null)
    const [explained, setExplained] = useState(false)
    const [deleting, setDeleting] = useState<ProfileSummary | null>(null)
    const { list, switching } = profiles
    if (!list) return null
    // The profile being switched to shows as on while the switch runs, so the menu can stay
    // open and answer the click at once.
    const shownActive = switching ?? list.active
    // With nothing to list, the menu has room to say what a profile is, right where the first
    // one is saved. Once there are profiles the info button shows it on request.
    const aboutShown = list.profiles.length === 0 || explained

    const active = list.profiles.find((p) => p.id === list.active) ?? null
    const switchingTo = list.profiles.find((p) => p.id === switching)
    const label = switchingTo
        ? t('installed.profiles.switching', { name: switchingTo.name })
        : (active?.name ?? t('installed.profiles.none'))

    // Resolves false when the change failed, which keeps the field open with what was typed.
    async function saveName(name: string): Promise<boolean> {
        if (editing?.kind === 'rename') {
            const current = list?.profiles.find((p) => p.id === editing.id)
            const saved = name === current?.name || (await profiles.rename(editing.id, name))
            if (saved) setEditing(null)
            return saved
        }
        if (editing?.kind === 'create') {
            const saved = await profiles.create(name, editing.source)
            if (saved) setEditing(null)
            return saved
        }
        return true
    }

    const rowAt = (profile: ProfileSummary) => {
        return (
            <ProfileRow
                key={profile.id}
                profile={profile}
                active={profile.id === shownActive}
                // After a stopped switch the mods match no profile, so going back to the
                // active one is a real switch.
                switchable={
                    switching === null &&
                    (profile.id !== list.active || list.unfinishedSwitch !== null)
                }
                renaming={editing?.kind === 'rename' && editing.id === profile.id}
                onSave={saveName}
                onCancel={() => setEditing(null)}
                onSwitch={() => void profiles.switchTo(profile.id)}
                onRename={() => setEditing({ kind: 'rename', id: profile.id })}
                onDuplicate={() =>
                    setEditing({
                        kind: 'create',
                        source: { kind: 'copy', profileId: profile.id },
                        initial: t('installed.profiles.copyName', { name: profile.name }),
                    })
                }
                onDelete={() => {
                    setOpen(false)
                    setEditing(null)
                    setDeleting(profile)
                }}
            />
        )
    }

    return (
        <>
            <Popover.Root
                open={open}
                onOpenChange={(next) => {
                    setOpen(next)
                    setExplained(false)
                    setEditing(null)
                }}
            >
                <Popover.Trigger asChild>
                    <Button
                        variant="secondary"
                        size="sm"
                        aria-label={t('installed.profiles.trigger', { name: label })}
                        disabled={switching !== null}
                        className="group max-w-48 disabled:cursor-wait"
                    >
                        {switching ? (
                            <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
                        ) : (
                            <Layers className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span className="truncate">{label}</span>
                        <ChevronDown className="w-3 h-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                    </Button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        align="end"
                        sideOffset={4}
                        // Focus stays on the trigger rather than landing on a row's controls and
                        // opening the Rename tooltip. Tab still reaches every row.
                        onOpenAutoFocus={(e) => e.preventDefault()}
                        // While a row is being edited, Escape cancels the edit and a second Escape
                        // closes the menu.
                        onEscapeKeyDown={(e) => {
                            if (!editing) return
                            e.preventDefault()
                            setEditing(null)
                        }}
                        // Above the title bar it opens from, which sits at z-[60] (TopBar.tsx).
                        className="z-[65] w-72 flex flex-col bg-surface-raised border border-border rounded shadow-lg text-text origin-(--radix-popover-content-transform-origin) data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out"
                    >
                        <div className="flex items-center gap-2 h-9 px-3 border-b border-border">
                            <span className="text-xs font-medium text-text-muted">
                                {t('installed.profiles.title')}
                            </span>
                            {list.profiles.length > 0 && (
                                <Tooltip content={t('installed.profiles.aboutLabel')}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={`focus-visible:ring-2 focus-visible:ring-accent/60 ${
                                            explained ? 'text-text bg-surface-hover' : ''
                                        }`}
                                        aria-label={t('installed.profiles.aboutLabel')}
                                        aria-expanded={explained}
                                        onClick={() => setExplained(!explained)}
                                    >
                                        <Info className="w-3.5 h-3.5" aria-hidden />
                                    </Button>
                                </Tooltip>
                            )}
                        </div>
                        {/* Rendered while hidden so it can close the way it opened. */}
                        <div
                            aria-hidden={!aboutShown}
                            className={`grid transition-[grid-template-rows,opacity] duration-surface ease-motion ${
                                aboutShown
                                    ? 'grid-rows-[1fr] opacity-100'
                                    : 'grid-rows-[0fr] opacity-0'
                            }`}
                        >
                            <div className="overflow-hidden">
                                <p className="px-3 py-2.5 border-b border-border text-xs text-text-subtle">
                                    {t('installed.profiles.about')}
                                </p>
                            </div>
                        </div>
                        {list.profiles.length > 0 && !active && (
                            <p className="px-3 py-2.5 border-b border-border text-xs text-warning">
                                {t('installed.profiles.noneActive')}
                            </p>
                        )}
                        {(list.profiles.length > 0 || editing?.kind === 'create') && (
                            <ul className="p-1 max-h-72 overflow-y-auto">
                                {list.profiles.map(rowAt)}
                                {editing?.kind === 'create' && (
                                    <li className="flex flex-col pl-2 pr-1 rounded border border-accent bg-accent/5">
                                        <div className="flex items-center gap-2 h-9">
                                            <Layers
                                                className="w-3.5 h-3.5 shrink-0 text-accent"
                                                aria-hidden
                                            />
                                            <NameField
                                                initial={editing.initial}
                                                onSave={saveName}
                                                onCancel={() => setEditing(null)}
                                            />
                                        </div>
                                        {/* A new profile starts without loaders, and offers to keep
                                            the ones installed only when there are some. */}
                                        {editing.source.kind === 'empty' &&
                                            list.loaders.length > 0 && (
                                                <label className="flex items-center gap-2 pb-2 pl-5.5 cursor-pointer select-none">
                                                    <input
                                                        type="checkbox"
                                                        checked={editing.source.keepLoaders}
                                                        onChange={(e) =>
                                                            setEditing({
                                                                ...editing,
                                                                source: {
                                                                    kind: 'empty',
                                                                    keepLoaders: e.target.checked,
                                                                },
                                                            })
                                                        }
                                                    />
                                                    <span className="text-xs text-text-muted">
                                                        {t('installed.profiles.keepLoaders', {
                                                            names: list.loaders.join(', '),
                                                        })}
                                                    </span>
                                                </label>
                                            )}
                                    </li>
                                )}
                            </ul>
                        )}
                        <div className="p-1 border-t border-border">
                            <button
                                onClick={() =>
                                    setEditing(
                                        active
                                            ? {
                                                  kind: 'create',
                                                  // A new profile starts over. Duplicate copies one.
                                                  source: { kind: 'empty', keepLoaders: false },
                                                  initial: '',
                                              }
                                            : {
                                                  kind: 'create',
                                                  // The first save keeps what is installed.
                                                  source: { kind: 'current' },
                                                  initial: t('installed.profiles.firstName'),
                                              }
                                    )
                                }
                                className="w-full flex items-center gap-2 px-2 h-8 rounded text-sm text-left text-text-muted hover:text-text hover:bg-surface-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                            >
                                <Plus className="w-4 h-4 shrink-0 text-text-subtle" />
                                {active
                                    ? t('installed.profiles.new')
                                    : t('installed.profiles.saveCurrent')}
                            </button>
                        </div>
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {deleting && (
                <DeleteProfileDialog
                    profile={deleting}
                    isActive={deleting.id === list.active}
                    onConfirm={async () => {
                        setDeleting(null)
                        await profiles.remove(deleting.id)
                    }}
                    onCancel={() => setDeleting(null)}
                />
            )}
        </>
    )
}

interface NameFieldProps {
    initial: string
    onSave: (name: string) => Promise<boolean>
    onCancel: () => void
}

/**
 * A name typed in place. Only the save button or Enter keeps it, and only the cancel button
 * or Escape drops it. Clicking anywhere else saves nothing, since a profile or a name the
 * user never confirmed must not appear.
 */
function NameField({ initial, onSave, onCancel }: NameFieldProps) {
    const [name, setName] = useState(initial)
    const [busy, setBusy] = useState(false)

    async function save() {
        setBusy(true)
        // A failed save leaves the field open with what was typed.
        await onSave(name.trim())
        setBusy(false)
    }

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault()
                if (name.trim()) void save()
            }}
            className="flex-1 min-w-0 flex items-center gap-1"
        >
            {/* Styled as the folder rename and new-folder fields in FolderSection.tsx. */}
            <input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                value={name}
                maxLength={64}
                aria-label={t('installed.profiles.name')}
                placeholder={t('installed.profiles.name')}
                onChange={(e) => setName(e.target.value)}
                className="name-field flex-1 min-w-0 bg-transparent text-sm outline-none border-b border-accent"
            />
            <Tooltip content={t('installed.profiles.save')}>
                <Button
                    type="submit"
                    variant="ghost-accent"
                    size="icon"
                    disabled={busy || !name.trim()}
                    aria-label={t('installed.profiles.save')}
                    className="shrink-0"
                >
                    <Check className="w-3.5 h-3.5" aria-hidden />
                </Button>
            </Tooltip>
            <Tooltip content={t('common.cancel')}>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('common.cancel')}
                    onClick={onCancel}
                    className="shrink-0"
                >
                    <X className="w-3.5 h-3.5" aria-hidden />
                </Button>
            </Tooltip>
        </form>
    )
}

interface RowProps {
    profile: ProfileSummary
    active: boolean
    switchable: boolean
    renaming: boolean
    onSave: (name: string) => Promise<boolean>
    onCancel: () => void
    onSwitch: () => void
    onRename: () => void
    onDuplicate: () => void
    onDelete: () => void
}

function ProfileRow({
    profile,
    active,
    switchable,
    renaming,
    onSave,
    onCancel,
    onSwitch,
    onRename,
    onDuplicate,
    onDelete,
}: RowProps) {
    const actions = [
        { label: t('installed.profiles.rename'), icon: Pencil, run: onRename },
        { label: t('installed.profiles.duplicate'), icon: Copy, run: onDuplicate },
        { label: t('installed.profiles.delete'), icon: Trash2, run: onDelete },
    ]
    return (
        <li
            aria-current={active || undefined}
            className={`group flex items-center gap-2 h-9 pl-2 pr-1 rounded transition-colors ${
                renaming
                    ? 'bg-surface-hover'
                    : 'hover:bg-surface-hover focus-within:bg-surface-hover'
            }`}
        >
            {/* Turning a profile on is the switch. The active one has nothing to turn off into,
                so its switch stays on. */}
            <Toggle
                checked={active}
                label={t('installed.profiles.switchTo', { name: profile.name })}
                onChange={() => switchable && onSwitch()}
            />
            {renaming ? (
                <NameField initial={profile.name} onSave={onSave} onCancel={onCancel} />
            ) : (
                <>
                    <span
                        className={`flex-1 min-w-0 truncate text-sm ${active ? 'text-text' : 'text-text-muted'}`}
                    >
                        {profile.name}
                    </span>
                    {actions.map(({ label, icon: Icon, run }) => (
                        <Tooltip key={label} content={label}>
                            <button
                                onClick={run}
                                aria-label={`${label} ${profile.name}`}
                                className="shrink-0 p-1 rounded text-text-subtle hover:text-text hover:bg-surface-active opacity-0 group-hover:opacity-100 focus:opacity-100 transition-[opacity,color,background-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                            >
                                <Icon className="w-3.5 h-3.5" />
                            </button>
                        </Tooltip>
                    ))}
                </>
            )}
        </li>
    )
}

interface DeleteDialogProps {
    profile: ProfileSummary
    isActive: boolean
    onConfirm: () => Promise<void>
    onCancel: () => void
}

function DeleteProfileDialog({ profile, isActive, onConfirm, onCancel }: DeleteDialogProps) {
    const title = t('installed.profiles.deleteTitle', { name: profile.name })
    return (
        <Dialog open onOpenChange={(o) => !o && onCancel()} title={title} className="w-80">
            <DialogHeader
                title={title}
                subtitle={
                    isActive
                        ? t('installed.profiles.deleteActiveConfirm')
                        : t('installed.profiles.deleteConfirm')
                }
                onClose={onCancel}
                wrapSubtitle
            />
            <div className="flex items-center justify-end gap-2 px-5 py-4">
                <Button variant="secondary" size="sm" onClick={onCancel}>
                    {t('common.cancel')}
                </Button>
                <Button variant="danger" size="sm" onClick={() => void onConfirm()}>
                    {t('installed.profiles.delete')}
                </Button>
            </div>
        </Dialog>
    )
}

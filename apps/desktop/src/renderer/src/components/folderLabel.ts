import { t, type StringKey } from '../i18n'
import type { ModFolderInfo } from '../api'

// The closed label vocabulary of game packages, TargetLabel in the game-package crate. The
// build validates every package against it, so a label missing here is a renderer that fell
// behind the crate, and it throws rather than show a raw key.
const FOLDER_LABEL_KEYS: Record<string, StringKey> = {
    mods: 'settings.folders.mods',
    pakMods: 'settings.folders.pakMods',
    modkitMods: 'settings.folders.modkitMods',
    legacyPaks: 'settings.folders.legacyPaks',
    overrides: 'settings.folders.overrides',
}

export function folderLabel(folder: ModFolderInfo): string {
    if (folder.labelKey === 'loaderMods') {
        if (!folder.labelName) throw new Error(`Mod folder ${folder.tag} names no loader`)
        return t('settings.folders.loaderMods', { name: folder.labelName })
    }
    const key = FOLDER_LABEL_KEYS[folder.labelKey]
    if (!key) throw new Error(`Unknown mod folder label ${folder.labelKey} for ${folder.tag}`)
    return t(key)
}

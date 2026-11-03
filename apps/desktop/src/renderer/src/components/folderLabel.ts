import { TARGET_LABEL_KEYS, type TargetLabelKey } from '@modrex/games'
import { t } from '../i18n'
import type { ModFolderInfo } from '../api'

// The label vocabulary is generated from the game-package crate's TargetLabel, so a label
// with no string under settings.folders fails the type check here instead of showing a raw key.
function isTargetLabelKey(key: string): key is TargetLabelKey {
    return (TARGET_LABEL_KEYS as readonly string[]).includes(key)
}

export function folderLabel(folder: ModFolderInfo): string {
    if (!isTargetLabelKey(folder.labelKey)) {
        throw new Error(`Unknown mod folder label ${folder.labelKey} for ${folder.tag}`)
    }
    if (folder.labelKey === 'loaderMods') {
        if (!folder.labelName) throw new Error(`Mod folder ${folder.tag} names no loader`)
        return t('settings.folders.loaderMods', { name: folder.labelName })
    }
    return t(`settings.folders.${folder.labelKey}`)
}

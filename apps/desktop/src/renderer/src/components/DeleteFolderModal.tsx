import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { Button } from './ui/Button'

interface Props {
    // The other Installed tabs whose mods sit in this folder and move with it.
    otherTabs: string | null
    onConfirm: () => void
    onCancel: () => void
}

export function DeleteFolderModal({ otherTabs, onConfirm, onCancel }: Props) {
    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onCancel()}
            title={t('installed.folder.delete')}
            className="w-80"
        >
            <DialogHeader
                title={t('installed.folder.delete')}
                subtitle={t('installed.folder.deleteConfirm')}
                onClose={onCancel}
                wrapSubtitle
            />
            {otherTabs && (
                <p className="px-5 pt-4 text-xs text-warning">
                    {t('installed.folder.deleteMovesOtherTabs', { tabs: otherTabs })}
                </p>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-4 shrink-0">
                <Button variant="secondary" size="sm" onClick={onCancel}>
                    {t('common.cancel')}
                </Button>
                <Button variant="danger" size="sm" onClick={onConfirm}>
                    {t('installed.folder.delete')}
                </Button>
            </div>
        </Dialog>
    )
}

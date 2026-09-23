import { useState } from 'react'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { FileRow } from './FileRow'
import { t } from '../i18n'
import type { InstalledMod, Mod, ModFile } from '../../../shared/types'

interface Props {
    mod: Mod
    files: ModFile[]
    installed: InstalledMod[]
    onChoose: (fileId: number) => void
    onCancel: () => void
}

export function UpdateFileModal({ mod, files, installed, onChoose, onCancel }: Props) {
    const [selected, setSelected] = useState<number | null>(
        () => files.find((file) => file.id === mod.download?.id)?.id ?? null
    )
    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onCancel()}
            title={t('installed.updatesModal.chooseTitle')}
            size="list"
            className="w-[540px]"
        >
            <DialogHeader
                title={t('installed.updatesModal.chooseTitle')}
                subtitle={t('installed.updatesModal.chooseBody', { name: mod.name })}
                onClose={onCancel}
            />
            <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-2">
                {files.map((file) => (
                    <FileRow
                        key={file.id}
                        file={file}
                        checked={selected === file.id}
                        installed={installed.some((ins) => ins.fileId === file.id)}
                        locked={false}
                        disabled={false}
                        status={null}
                        onToggle={() => setSelected(file.id)}
                    />
                ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button variant="secondary" size="md" onClick={onCancel}>
                    {t('common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="lg"
                    disabled={selected === null}
                    onClick={() => selected !== null && onChoose(selected)}
                >
                    {t('installed.updatesModal.update')}
                </Button>
            </div>
        </Dialog>
    )
}

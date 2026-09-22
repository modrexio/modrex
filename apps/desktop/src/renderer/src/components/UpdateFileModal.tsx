import { useState } from 'react'
import { Clock, Tag } from 'lucide-react'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
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
            className="w-[32rem]"
        >
            <DialogHeader
                title={t('installed.updatesModal.chooseTitle')}
                subtitle={t('installed.updatesModal.chooseBody', { name: mod.name })}
                onClose={onCancel}
                wrapSubtitle
            />
            <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-2">
                {files.map((file) => (
                    <label
                        key={file.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                            selected === file.id
                                ? 'bg-accent/5 border-accent/40'
                                : 'bg-surface-hover border-border'
                        }`}
                    >
                        <input
                            type="radio"
                            name="update-file"
                            checked={selected === file.id}
                            onChange={() => setSelected(file.id)}
                            className="w-4 h-4 shrink-0 cursor-pointer"
                        />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold truncate">{file.name}</span>
                                {installed.some((ins) => ins.fileId === file.id) && (
                                    <span className="text-xs text-success-text shrink-0">
                                        {t('common.installed')}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                                {file.version && (
                                    <span className="flex items-center gap-1">
                                        <Tag className="w-3 h-3 shrink-0" />
                                        {file.version}
                                    </span>
                                )}
                                {file.created_at && (
                                    <span className="flex items-center gap-1">
                                        <Clock className="w-3 h-3 shrink-0" />
                                        {new Date(file.created_at).toLocaleDateString(undefined, {
                                            year: 'numeric',
                                            month: 'short',
                                            day: 'numeric',
                                        })}
                                    </span>
                                )}
                            </div>
                        </div>
                    </label>
                ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button variant="secondary" size="sm" onClick={onCancel}>
                    {t('common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="sm"
                    disabled={selected === null}
                    onClick={() => selected !== null && onChoose(selected)}
                >
                    {t('installed.updatesModal.update')}
                </Button>
            </div>
        </Dialog>
    )
}

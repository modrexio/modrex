import { ScrollArea } from './ScrollArea'
import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { Dialog, DialogHeader } from './Dialog'
import { ModworkshopMarkup } from './MarkdownContent'
import { t } from '../i18n'
import { getCachedMod } from '../modCache'
import { SkeletonText } from './Skeleton'

interface Props {
    modId: number
    onClose: () => void
}

/**
 * Shown when an archive fits no scan target and is not a known host pack, meaning it
 * installs inside some other mod that Modrex can't infer. Surfaces the author's instructions
 * instead of silently mislaying the files.
 */
export function UnrecognizedArchiveModal({ modId, onClose }: Props) {
    const [instructions, setInstructions] = useState<string | null>(null)
    const [legacyMarkup, setLegacyMarkup] = useState(false)

    useEffect(() => {
        let cancelled = false
        getCachedMod(modId)
            .then((m) => {
                if (!cancelled) {
                    setInstructions(m.instructs_template?.instructions || m.instructions || '')
                    setLegacyMarkup(m.legacy_markup)
                }
            })
            .catch(() => {
                if (!cancelled) setInstructions('')
            })
        return () => {
            cancelled = true
        }
    }, [modId])

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onClose()}
            title={t('unrecognized.title')}
            size="list"
            className="w-[480px]"
        >
            <DialogHeader title={t('unrecognized.title')} onClose={onClose} />

            <ScrollArea
                hostClassName="flex-1"
                className="px-5 py-4 overflow-y-auto flex flex-col gap-3"
            >
                <p className="text-sm text-text-muted">{t('unrecognized.body')}</p>
                {instructions === null ? (
                    <SkeletonText />
                ) : instructions ? (
                    <div className="rounded-lg border border-border bg-surface-hover px-4 py-3 text-sm">
                        <ModworkshopMarkup text={instructions} legacy={legacyMarkup} />
                    </div>
                ) : (
                    <p className="text-sm text-text-subtle">{t('unrecognized.noInstructions')}</p>
                )}
            </ScrollArea>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button variant="accent" size="lg" onClick={onClose}>
                    {t('common.close')}
                </Button>
            </div>
        </Dialog>
    )
}

import { useRef } from 'react'
import { ExternalLink } from 'lucide-react'
import contributorData from '../../../../translation-contributors.generated.json'
import { api } from '../api'
import { getLocale, t } from '../i18n'
import { LOCALE_IDS, localeNativeName } from '../locales'
import { TRANSLATION_COVERAGE } from '../translationStatus'
import { Dialog, DialogHeader } from './Dialog'
import { ScrollArea } from './ScrollArea'
import { Button } from './ui/Button'

const CONTRIBUTORS: Record<string, string[]> = contributorData
const TRANSLATION_GUIDE =
    'https://github.com/modrexio/modrex/blob/main/docs/contributing/translating.md'

interface Props {
    open: boolean
    onClose: () => void
    returnFocus: () => void
}

export function TranslationStatusDialog({ open, onClose, returnFocus }: Props) {
    const title = useRef<HTMLSpanElement>(null)
    const locale = getLocale()
    const percentage = new Intl.NumberFormat(locale, {
        style: 'percent',
        maximumFractionDigits: 1,
    })

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) onClose()
            }}
            title={t('settings.language.status')}
            className="w-[36rem] max-w-[90vw] max-h-[75vh] [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-accent/60"
            onOpenAutoFocus={(event) => {
                event.preventDefault()
                title.current!.focus()
            }}
            onCloseAutoFocus={(event) => {
                event.preventDefault()
                returnFocus()
            }}
        >
            <DialogHeader
                title={
                    <span ref={title} tabIndex={-1} className="outline-none">
                        {t('settings.language.status')}
                    </span>
                }
                subtitle={t('settings.language.statusDescription')}
                onClose={onClose}
                wrapSubtitle
            />
            <ScrollArea hostClassName="min-h-0" className="overflow-y-auto px-5">
                <table className="w-full table-fixed text-left text-xs">
                    <thead className="sticky top-0 bg-surface-raised text-text-muted">
                        <tr className="border-b border-border">
                            <th scope="col" className="w-[36%] py-2 pr-3 font-medium">
                                {t('settings.language.title')}
                            </th>
                            <th scope="col" className="w-[26%] px-3 py-2 font-medium">
                                {t('settings.language.coverage')}
                            </th>
                            <th scope="col" className="py-2 pl-3 font-medium">
                                {t('settings.language.contributors')}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {LOCALE_IDS.map((id) => {
                            const { translated, total } = TRANSLATION_COVERAGE[id]
                            const ratio = translated / total
                            return (
                                <tr key={id} className="border-b border-border last:border-0">
                                    <td className="py-2 pr-3">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span lang={id} className="text-sm">
                                                {localeNativeName(id)}
                                            </span>
                                            <span className="text-text-subtle">
                                                {id.toUpperCase()}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <div
                                                className="h-1 flex-1 rounded-full bg-surface-active overflow-hidden"
                                                aria-hidden
                                            >
                                                <div
                                                    className="h-full rounded-full bg-accent"
                                                    style={{ width: `${ratio * 100}%` }}
                                                />
                                            </div>
                                            <span className="text-text-muted tabular-nums shrink-0">
                                                {percentage.format(ratio)}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="py-2 pl-3">
                                        {CONTRIBUTORS[id] ? (
                                            <div className="flex flex-wrap gap-x-2 gap-y-1">
                                                {[...CONTRIBUTORS[id]].sort().map((username) => (
                                                    <Button
                                                        key={username}
                                                        variant="ghost-accent"
                                                        size="sm"
                                                        className="max-w-full px-0 py-0 break-all text-left justify-start"
                                                        onClick={() =>
                                                            api.openExternal(
                                                                `https://github.com/${username}`
                                                            )
                                                        }
                                                    >
                                                        {username}
                                                    </Button>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-text-subtle">
                                                <span aria-hidden>-</span>
                                                <span className="sr-only">
                                                    {t('settings.language.noContributors')}
                                                </span>
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </ScrollArea>
            <div className="flex items-center gap-3 px-5 py-4 border-t border-border shrink-0">
                <Button
                    variant="ghost-accent"
                    size="sm"
                    onClick={() => api.openExternal(TRANSLATION_GUIDE)}
                >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                    {t('settings.language.helpTranslate')}
                </Button>
                <Button variant="secondary" size="sm" className="ml-auto" onClick={onClose}>
                    {t('common.close')}
                </Button>
            </div>
        </Dialog>
    )
}

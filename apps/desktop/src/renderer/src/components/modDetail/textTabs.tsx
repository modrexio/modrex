import type { Mod, ModSummary } from '../../../../shared/types'
import { ModworkshopMarkup } from '../MarkdownContent'
import { t } from '../../i18n'

export function DescriptionTab({
    mod,
    onOpenDetail,
}: {
    mod: ModSummary
    onOpenDetail?: (modId: number) => void
}) {
    return (
        <div>
            {mod.desc ? (
                <ModworkshopMarkup text={mod.desc} onOpenDetail={onOpenDetail} />
            ) : (
                <p className="text-sm text-text-subtle">{t('detail.description.noDescription')}</p>
            )}
        </div>
    )
}

export function ChangelogTab({
    mod,
    onOpenDetail,
}: {
    mod: Mod
    onOpenDetail?: (modId: number) => void
}) {
    return (
        <div>
            <ModworkshopMarkup text={mod.changelog!} onOpenDetail={onOpenDetail} />
        </div>
    )
}

export function LicenseTab({
    mod,
    onOpenDetail,
}: {
    mod: Mod
    onOpenDetail?: (modId: number) => void
}) {
    return (
        <div>
            <ModworkshopMarkup text={mod.license!} onOpenDetail={onOpenDetail} />
        </div>
    )
}

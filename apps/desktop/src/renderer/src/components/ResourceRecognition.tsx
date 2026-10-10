import { t } from '../i18n'
import type { ResourceRecognition as Recognition } from '../api'

export function ResourceRecognition({
    recognition,
}: {
    recognition: Extract<Recognition, { status: 'matched' | 'ambiguous' }>
}) {
    if (recognition.status === 'matched') {
        return (
            <span className="text-success-text">
                {t('resources.recognition.matched', { name: recognition.modName })}
            </span>
        )
    }
    return (
        <span className="text-text-muted">{t(`resources.recognition.${recognition.status}`)}</span>
    )
}

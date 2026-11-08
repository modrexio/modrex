import { ExternalLink } from 'lucide-react'
import { Button } from './ui/Button'
import { api, type UpdatedNotice } from '../api'
import { t } from '../i18n'

// Shown after an update installed when Modrex opened. That flow shows release notes nowhere
// else, so the changelog link lives here.
export function UpdatedBanner({ notice, onClose }: { notice: UpdatedNotice; onClose: () => void }) {
    return (
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-surface-raised border-b border-border">
            <span className="text-sm text-text-muted">
                {t('app.updatedNotice', { version: notice.version })}
            </span>
            <div className="flex items-center gap-2 shrink-0">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => api.openExternal(notice.releaseUrl)}
                >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t('app.updatedChangelog')}
                </Button>
                <Button variant="ghost" size="sm" onClick={onClose}>
                    {t('common.dismiss')}
                </Button>
            </div>
        </div>
    )
}

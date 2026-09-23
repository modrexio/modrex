import { Tag, Download, Clock, AlertTriangle } from 'lucide-react'
import type { ModFile } from '../../../shared/types'
import { t } from '../i18n'
import { MarkdownContent } from './MarkdownContent'
import { isUnsupportedFormat } from '../formatCheck'

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${parseFloat((bytes / 1024 / 1024).toFixed(1))} MB`
}

interface Props {
    file: ModFile
    checked: boolean
    installed: boolean
    locked: boolean
    disabled: boolean
    status: string | null
    onToggle: () => void
}

export function FileRow({ file, checked, installed, locked, disabled, status, onToggle }: Props) {
    return (
        <div
            onClick={() => !locked && !disabled && onToggle()}
            className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                locked
                    ? 'bg-surface-hover border-border opacity-60'
                    : checked
                      ? 'bg-accent/5 border-accent/40 cursor-pointer'
                      : 'bg-surface-hover border-border cursor-pointer'
            }`}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={locked || disabled}
                onChange={onToggle}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {file.label && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent font-medium uppercase tracking-wide shrink-0">
                            {file.label}
                        </span>
                    )}
                    <span className="text-sm font-semibold truncate">{file.name}</span>
                    {status ? (
                        <span className="text-xs text-text-muted shrink-0">{status}</span>
                    ) : installed ? (
                        <span className="text-xs text-success-text shrink-0">
                            {t('common.installed')}
                        </span>
                    ) : null}
                </div>
                {file.desc && (
                    <div className="text-xs text-text-muted mt-1 [&_a]:text-accent-bright [&_a]:hover:underline">
                        <MarkdownContent text={file.desc} />
                    </div>
                )}
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                    <span className="uppercase">{file.type}</span>
                    <span>{formatBytes(file.size)}</span>
                    {isUnsupportedFormat(file.type, file.download_url) && (
                        <span className="flex items-center gap-1 text-warning">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            {t('common.nonPakWarning')}
                        </span>
                    )}
                    {file.version && (
                        <span className="flex items-center gap-1">
                            <Tag className="w-3 h-3 shrink-0" />
                            {file.version}
                        </span>
                    )}
                    {file.downloads != null && (
                        <span className="flex items-center gap-1">
                            <Download className="w-3 h-3 shrink-0" />
                            {file.downloads.toLocaleString()}
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
        </div>
    )
}

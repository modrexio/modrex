import { useState } from 'react'

function buildPages(current: number, last: number): (number | '...')[] {
    const pages: (number | '...')[] = []
    const delta = 2
    const left = current - delta
    const right = current + delta

    let prev: number | null = null
    for (let p = 1; p <= last; p++) {
        if (p === 1 || p === last || (p >= left && p <= right)) {
            if (prev !== null && p - prev > 1) pages.push('...')
            pages.push(p)
            prev = p
        }
    }
    return pages
}

interface Props {
    page: number
    // Null while the page count is unknown, which is every moment a page is loading.
    lastPage: number | null
    label?: string | null
    onPageChange: (page: number) => void
}

// The footer keeps the last known page count and label while lastPage is null. A page
// drops its result before each fetch, and a footer that followed it would unmount for
// the length of the request, resizing the grid above it on every page click.
export function PaginationFooter({ page, lastPage, label = null, onPageChange }: Props) {
    const [known, setKnown] = useState<{ lastPage: number; label: string | null } | null>(null)
    if (lastPage !== null && (known?.lastPage !== lastPage || known.label !== label)) {
        setKnown({ lastPage, label })
    }

    const shown = lastPage !== null ? { lastPage, label } : known
    if (!shown || shown.lastPage <= 1) return null

    return (
        <div className="px-6 py-3 border-t border-border flex items-center justify-between shrink-0">
            <span className="text-xs text-text-subtle">{shown.label}</span>
            <div className="flex gap-1">
                {buildPages(page, shown.lastPage).map((p, i) =>
                    p === '...' ? (
                        <span key={`ellipsis-${i}`} className="text-xs px-2 py-1 text-text-subtle">
                            …
                        </span>
                    ) : (
                        <button
                            key={p}
                            onClick={() => onPageChange(p)}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                                p === page
                                    ? 'bg-accent-fill text-white'
                                    : 'bg-surface-hover hover:bg-surface-active'
                            }`}
                        >
                            {p}
                        </button>
                    )
                )}
            </div>
        </div>
    )
}

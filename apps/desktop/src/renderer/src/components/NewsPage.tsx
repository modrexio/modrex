import { ScrollArea } from './ScrollArea'
import { memo, useEffect, useState } from 'react'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { RefreshCw, ExternalLink, Image as ImageIcon } from 'lucide-react'
import { api } from '../api'
import { t } from '../i18n'
import { GAMES } from '../../../shared/types'
import type { GameId, NewsItem } from '../../../shared/types'
import { SkeletonCard } from './SkeletonCard'
import { Tooltip } from './Tooltip'

const SOURCE_URL = 'https://www.paydaythegame.com/'

// Cached per game for the session so navigating away and back (or switching
// games) restores the page the user was on instead of resetting to page 1.
const newsCache = new Map<GameId, { items: NewsItem[]; totalPages: number; page: number }>()

interface Props {
    isActive: boolean
    activeGame: GameId
}

// Mirrors BrowsePage's buildPages: first, last, and a window around current,
// with '...' filling the gaps.
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

function NewsCard({ item }: { item: NewsItem }) {
    const [imgFailed, setImgFailed] = useState(false)

    return (
        <div className="h-full bg-surface-raised border border-border rounded-lg overflow-hidden flex flex-col transition-colors hover:border-accent/25">
            {item.image && !imgFailed ? (
                <img
                    src={item.image}
                    alt={item.title}
                    loading="lazy"
                    onError={() => setImgFailed(true)}
                    className="w-full h-36 object-cover"
                />
            ) : (
                <div className="w-full h-36 bg-surface-hover flex items-center justify-center">
                    <ImageIcon className="w-8 h-8 text-text-subtle" aria-hidden="true" />
                    <span className="sr-only">{t('common.noImage')}</span>
                </div>
            )}
            <div className="px-3 pt-3 pb-1 flex flex-col gap-1 flex-1">
                <span className="text-xs text-text-subtle">{item.date}</span>
                <h3 className="text-sm font-semibold leading-snug line-clamp-2">{item.title}</h3>
                <p className="text-xs text-text-subtle line-clamp-3">{item.excerpt}</p>
            </div>
            <div className="px-3 pb-3 pt-2 flex items-center mt-auto">
                <Tooltip content={t('news.readArticle')}>
                    <button
                        onClick={() => api.openExternal(item.url)}
                        className="p-1.5 rounded bg-accent-fill hover:bg-accent-fill-hover transition-colors"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                </Tooltip>
            </div>
        </div>
    )
}

function NewsPageImpl({ isActive, activeGame }: Props) {
    const cached = newsCache.get(activeGame)
    const [items, setItems] = useState<NewsItem[] | null>(cached?.items ?? null)
    const [totalPages, setTotalPages] = useState(cached?.totalPages ?? 1)
    const [page, setPage] = useState(cached?.page ?? 1)
    const [loading, setLoading] = useState(items === null)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState(false)

    useEffect(() => {
        if (!isActive) return
        const existing = newsCache.get(activeGame)
        if (existing) {
            setItems(existing.items)
            setTotalPages(existing.totalPages)
            setPage(existing.page)
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        setError(false)
        api.fetchNews(activeGame)
            .then((result) => {
                if (cancelled) return
                newsCache.set(activeGame, {
                    items: result.items,
                    totalPages: result.totalPages,
                    page: 1,
                })
                setItems(result.items)
                setTotalPages(result.totalPages)
                setPage(1)
            })
            .catch(() => {
                if (!cancelled) setError(true)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [isActive, activeGame])

    async function handleRefresh() {
        setRefreshing(true)
        setError(false)
        try {
            const result = await api.refreshNews(activeGame)
            newsCache.set(activeGame, {
                items: result.items,
                totalPages: result.totalPages,
                page: 1,
            })
            setItems(result.items)
            setTotalPages(result.totalPages)
            setPage(1)
        } catch {
            setError(true)
        } finally {
            setRefreshing(false)
        }
    }

    async function handlePageChange(p: number) {
        if (p === page) return
        setPage(p)
        setLoading(true)
        setError(false)
        try {
            const result =
                p === 1 ? await api.fetchNews(activeGame) : await api.fetchNewsPage(activeGame, p)
            newsCache.set(activeGame, {
                items: result.items,
                totalPages: result.totalPages,
                page: p,
            })
            setItems(result.items)
            setTotalPages(result.totalPages)
        } catch {
            setError(true)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="h-full flex flex-col">
            <div className="px-6 py-4 shrink-0">
                <p className="text-xs text-text-subtle uppercase tracking-wide">
                    {GAMES[activeGame].name}
                </p>
                <div className={`flex items-center gap-2 ${TITLE_ROW_MIN_H}`}>
                    <h1 className="text-2xl font-semibold leading-none">{t('news.title')}</h1>
                    <Tooltip content={t('news.refresh')}>
                        <button
                            onClick={handleRefresh}
                            disabled={refreshing || loading}
                            className="p-1 rounded bg-surface-hover hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-text-subtle hover:text-text transition-colors"
                        >
                            <RefreshCw
                                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                            />
                        </button>
                    </Tooltip>
                </div>
                <p className="text-sm text-text-muted mt-1">
                    {t('news.subtitlePrefix')}{' '}
                    <button
                        onClick={() => api.openExternal(SOURCE_URL)}
                        className="text-accent hover:text-accent-bright underline-offset-2 hover:underline transition-colors"
                    >
                        {t('news.source')}
                    </button>
                    .
                </p>
            </div>

            <ScrollArea hostClassName="flex-1" className="overflow-y-auto px-6 pb-6">
                {loading ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
                        {Array.from({ length: 8 }, (_, i) => (
                            <SkeletonCard key={i} />
                        ))}
                    </div>
                ) : error && (!items || items.length === 0) ? (
                    <p className="text-sm text-text-subtle">{t('news.loadFailed')}</p>
                ) : !items || items.length === 0 ? (
                    <p className="text-sm text-text-subtle">{t('news.empty')}</p>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
                        {items.map((item) => (
                            <NewsCard key={item.url} item={item} />
                        ))}
                    </div>
                )}
            </ScrollArea>

            {items && items.length > 0 && totalPages > 1 && (
                <div className="px-6 py-3 border-t border-border flex items-center justify-end shrink-0">
                    <div className="flex gap-1">
                        {buildPages(page, totalPages).map((p, i) =>
                            p === '...' ? (
                                <span
                                    key={`ellipsis-${i}`}
                                    className="text-xs px-2 py-1 text-text-subtle"
                                >
                                    …
                                </span>
                            ) : (
                                <button
                                    key={p}
                                    onClick={() => handlePageChange(p as number)}
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
            )}
        </div>
    )
}

export const NewsPage = memo(NewsPageImpl)

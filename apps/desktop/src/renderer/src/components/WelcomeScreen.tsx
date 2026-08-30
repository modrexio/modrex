import { useEffect, useState } from 'react'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { Search } from 'lucide-react'
import type { GameId } from '../../../shared/types'
import { GAMES } from '../../../shared/types'
import { t } from '../i18n'
import { api } from '../api'
import { Toggle } from './Toggle'
import { SearchClearButton } from './ui/SearchClearButton'

const INSTALLED_ONLY_KEY = 'modrex:show-installed-games-only'

const CDN_URLS: Partial<Record<GameId, string>> = {
    pd3: 'https://cdn.akamai.steamstatic.com/steam/apps/1272080/library_600x900.jpg',
    pd2: 'https://cdn.akamai.steamstatic.com/steam/apps/218620/library_600x900.jpg',
    pdth: 'https://cdn.akamai.steamstatic.com/steam/apps/24240/library_600x900.jpg',
    cb: 'https://cdn.akamai.steamstatic.com/steam/apps/2933080/library_600x900.jpg',
    raid: 'https://cdn.akamai.steamstatic.com/steam/apps/414740/library_600x900.jpg',
}

const FALLBACK_STYLES: Partial<Record<GameId, { background: string; nameColor: string }>> = {
    pd3: { background: 'linear-gradient(135deg, #1c0808 0%, #3d1212 100%)', nameColor: '#e05555' },
    pd2: { background: 'linear-gradient(135deg, #1a1306 0%, #3d2d0f 100%)', nameColor: '#e09020' },
    pdth: { background: 'linear-gradient(135deg, #060d1a 0%, #0f1f3d 100%)', nameColor: '#5588cc' },
    cb: { background: 'linear-gradient(135deg, #1a062b 0%, #3d0f3a 100%)', nameColor: '#e055c9' },
    raid: {
        background: 'linear-gradient(135deg, #131806 0%, #333d0f 100%)',
        nameColor: '#a9c34f',
    },
}

const DEFAULT_STYLE = {
    background: 'linear-gradient(135deg, #0f1014 0%, #262a33 100%)',
    nameColor: '#c9ced9',
}

interface Props {
    onSelectGame: (g: GameId) => void
}

export function WelcomeScreen({ onSelectGame }: Props) {
    const [failed, setFailed] = useState<Partial<Record<GameId, boolean>>>({})
    const [query, setQuery] = useState('')
    const [installedOnly, setInstalledOnly] = useState(
        () => localStorage.getItem(INSTALLED_ONLY_KEY) === 'true'
    )
    const [installedStatus, setInstalledStatus] = useState<Partial<Record<GameId, boolean>>>({})

    useEffect(() => {
        let cancelled = false
        for (const g of Object.keys(GAMES) as GameId[]) {
            // Seed from the saved path so the filter answers instantly; full
            // detection below can take seconds and overwrites the seed when done.
            void api.getGameSettings(g).then((gs) => {
                if (cancelled) return
                setInstalledStatus((prev) =>
                    g in prev ? prev : { ...prev, [g]: gs.gamePath != null }
                )
            })
        }
        void api.detectInstalledGames().then((installed) => {
            if (cancelled) return
            const found = new Set(installed)
            setInstalledStatus(
                Object.fromEntries((Object.keys(GAMES) as GameId[]).map((g) => [g, found.has(g)]))
            )
        })
        return () => {
            cancelled = true
        }
    }, [])

    function handleInstalledOnlyChange(checked: boolean) {
        setInstalledOnly(checked)
        localStorage.setItem(INSTALLED_ONLY_KEY, String(checked))
    }

    const normalizedQuery = query.trim().toLowerCase()
    const games = (Object.keys(GAMES) as GameId[]).filter((g) => {
        const game = GAMES[g]
        if (installedOnly && !installedStatus[g]) return false
        return (
            !normalizedQuery ||
            game.name.toLowerCase().includes(normalizedQuery) ||
            game.shortName.toLowerCase().includes(normalizedQuery)
        )
    })

    return (
        <div className="h-full bg-surface text-text flex flex-col">
            <div className="px-6 py-4 border-b border-border shrink-0 flex flex-col gap-3">
                <div className={`flex items-center gap-3 ${TITLE_ROW_MIN_H}`}>
                    <h1 className="text-lg font-semibold">{t('gamePicker.title')}</h1>
                    <div className="flex items-center gap-2">
                        <Toggle checked={installedOnly} onChange={handleInstalledOnlyChange} />
                        <span className="text-xs text-text-muted">
                            {t('gamePicker.installedOnly')}
                        </span>
                    </div>
                </div>
                <label className="relative block w-full">
                    <span className="sr-only">{t('gamePicker.searchLabel')}</span>
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('gamePicker.searchPlaceholder')}
                        className={`w-full text-sm pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${query ? 'pr-7' : 'pr-3'}`}
                    />
                    {query && <SearchClearButton onClick={() => setQuery('')} />}
                </label>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
                {games.length ? (
                    <div className="grid grid-cols-[repeat(auto-fill,200px)] gap-6">
                        {games.map((g) => {
                            const fallback = FALLBACK_STYLES[g] ?? DEFAULT_STYLE
                            const showFallback = failed[g] || !CDN_URLS[g]
                            return (
                                <button
                                    key={g}
                                    onClick={() => onSelectGame(g)}
                                    aria-label={GAMES[g].name}
                                    className="group relative aspect-[2/3] overflow-hidden rounded-lg border border-border bg-surface-raised transition-all duration-200 hover:scale-[1.03] hover:border-accent/60 focus-visible:outline-none focus-visible:border-accent/60"
                                >
                                    {showFallback ? (
                                        <div
                                            className="absolute inset-0 flex items-center justify-center p-4 text-center"
                                            style={{ background: fallback.background }}
                                        >
                                            <span
                                                style={{
                                                    fontFamily: "'Bebas Neue', sans-serif",
                                                    fontSize: '2rem',
                                                    letterSpacing: '0.08em',
                                                    color: fallback.nameColor,
                                                    lineHeight: 1,
                                                }}
                                            >
                                                {GAMES[g].name}
                                            </span>
                                        </div>
                                    ) : (
                                        <img
                                            src={CDN_URLS[g]}
                                            alt=""
                                            className="absolute inset-0 h-full w-full object-contain"
                                            draggable={false}
                                            onError={() =>
                                                setFailed((prev) => ({ ...prev, [g]: true }))
                                            }
                                        />
                                    )}
                                    <div className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/10" />
                                </button>
                            )
                        })}
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-text-subtle">
                        {t('gamePicker.noMatches')}
                    </div>
                )}
            </div>
        </div>
    )
}

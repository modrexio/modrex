import { ScrollArea } from './ScrollArea'
import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import { Tag as TagIcon, ChevronDown, Plus, Minus, X } from 'lucide-react'
import type { ModTag } from '../../../shared/types'
import { Tooltip } from './Tooltip'
import { SearchClearButton } from './ui/SearchClearButton'
import { t } from '../i18n'

const MAX_PER_BUCKET = 10

type TagState = 'neutral' | 'include' | 'exclude'

interface Props {
    tags: ModTag[]
    include: number[]
    exclude: number[]
    onChange: (include: number[], exclude: number[]) => void
}

export function TagFilter({ tags, include, exclude, onChange }: Props) {
    const [search, setSearch] = useState('')
    const selectedCount = include.length + exclude.length

    const stateOf = (id: number): TagState =>
        include.includes(id) ? 'include' : exclude.includes(id) ? 'exclude' : 'neutral'

    function cycle(id: number) {
        const inc = include.filter((x) => x !== id)
        const exc = exclude.filter((x) => x !== id)
        const state = stateOf(id)
        if (state === 'neutral') {
            if (inc.length < MAX_PER_BUCKET) return onChange([...inc, id], exc)
            if (exc.length < MAX_PER_BUCKET) return onChange(inc, [...exc, id])
            return
        }
        if (state === 'include') {
            if (exc.length < MAX_PER_BUCKET) return onChange(inc, [...exc, id])
            return onChange(inc, exc)
        }
        return onChange(inc, exc)
    }

    const q = search.trim().toLowerCase()
    const filtered = q ? tags.filter((tag) => tag.name.toLowerCase().includes(q)) : tags

    const active = selectedCount > 0

    return (
        <Popover.Root>
            <Popover.Trigger
                className={`group text-sm px-3 py-1.5 rounded bg-surface-hover border flex items-center gap-2 hover:bg-surface-active transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${active ? 'border-accent text-accent' : 'border-border text-text'}`}
            >
                <TagIcon className="w-3.5 h-3.5 text-text-subtle" />
                <span>
                    {active ? t('browse.tagsCount', { count: selectedCount }) : t('browse.tags')}
                </span>
                <ChevronDown className="w-3 h-3 shrink-0 text-text-subtle transition-transform group-data-[state=open]:rotate-180" />
            </Popover.Trigger>

            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={4}
                    className="z-50 w-fit min-w-[11rem] max-w-[24rem] flex flex-col max-h-[360px] bg-surface-raised border border-border rounded shadow-lg text-text"
                >
                    <div className="p-2 border-b border-border flex items-center gap-2">
                        <div className="relative flex-1 min-w-0">
                            <input
                                type="text"
                                size={1}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t('browse.tagFilterSearch')}
                                className={`w-full text-sm px-2 py-1 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${search ? 'pr-7' : ''}`}
                            />
                            {search && <SearchClearButton onClick={() => setSearch('')} />}
                        </div>
                        {active && (
                            <Tooltip content={t('browse.tagFilterClear')}>
                                <button
                                    onClick={() => onChange([], [])}
                                    className="shrink-0 p-1 rounded text-text-subtle hover:text-text hover:bg-surface-active transition-colors"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </Tooltip>
                        )}
                    </div>

                    <ScrollArea className="overflow-y-auto p-1">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-4 text-center text-xs text-text-subtle">
                                {t('browse.tagFilterEmpty')}
                            </div>
                        ) : (
                            filtered.map((tag) => {
                                const state = stateOf(tag.id)
                                return (
                                    <button
                                        key={tag.id}
                                        onClick={() => cycle(tag.id)}
                                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors ${
                                            state === 'include'
                                                ? 'bg-success/15'
                                                : state === 'exclude'
                                                  ? 'bg-danger/15'
                                                  : 'hover:bg-surface-hover'
                                        }`}
                                    >
                                        <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                                            {state === 'include' ? (
                                                <Plus className="w-3.5 h-3.5 text-success-text" />
                                            ) : state === 'exclude' ? (
                                                <Minus className="w-3.5 h-3.5 text-danger-text" />
                                            ) : (
                                                <span className="w-1.5 h-1.5 rounded-full bg-text-subtle" />
                                            )}
                                        </span>
                                        <span
                                            className="text-xs px-2 py-0.5 rounded-full border"
                                            style={{
                                                borderColor: tag.color + '80',
                                                color: tag.color,
                                                backgroundColor: tag.color + '18',
                                            }}
                                        >
                                            {tag.name}
                                        </span>
                                    </button>
                                )
                            })
                        )}
                    </ScrollArea>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

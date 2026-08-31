import { useEffect, useMemo, useState } from 'react'
import {
    ChevronRight,
    File,
    FileArchive,
    Folder,
    Loader,
    Search,
    TriangleAlert,
} from 'lucide-react'
import { Dialog, DialogHeader } from './Dialog'
import { SearchClearButton } from './ui/SearchClearButton'
import { t } from '../i18n'
import { api, type PakAsset } from '../api'

interface Props {
    modName: string
    uid: string
    gameId: string
    onClose: () => void
}

export interface TreeNode {
    name: string
    path: string
    asset: PakAsset | null
    children: TreeNode[]
}

function formatPakSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    let value = bytes
    for (const unit of ['KB', 'MB', 'GB', 'TB']) {
        value /= 1024
        if (value < 1024) return `${value.toFixed(1)} ${unit}`
    }
    return `${value.toFixed(1)} TB`
}

export function buildTree(assets: PakAsset[]): TreeNode {
    const root: TreeNode = { name: '', path: '', asset: null, children: [] }
    for (const asset of assets) {
        const parts = asset.path.split('/')
        let node = root
        let prefix = ''
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]
            prefix = prefix === '' ? part : `${prefix}/${part}`
            if (i === parts.length - 1) {
                node.children.push({ name: part, path: prefix, asset, children: [] })
            } else {
                let child = node.children.find((c) => c.asset === null && c.name === part)
                if (!child) {
                    child = { name: part, path: prefix, asset: null, children: [] }
                    node.children.push(child)
                }
                node = child
            }
        }
    }
    return root
}

export function filterTree(node: TreeNode, q: string): TreeNode | null {
    const needle = q.toLowerCase()
    if (node.asset !== null) {
        const matches =
            node.asset.path.toLowerCase().includes(needle) ||
            (node.asset.class !== null && node.asset.class.toLowerCase().includes(needle))
        return matches ? node : null
    }
    const children: TreeNode[] = []
    for (const child of node.children) {
        const filtered = filterTree(child, q)
        if (filtered !== null) children.push(filtered)
    }
    if (children.length === 0) return null
    return { ...node, children }
}

export function countFiles(node: TreeNode): number {
    if (node.asset !== null) return 1
    return node.children.reduce((sum, child) => sum + countFiles(child), 0)
}

interface TreeRowProps {
    node: TreeNode
    depth: number
    expanded: Set<string>
    searching: boolean
    onToggle: (path: string) => void
}

function TreeRow({ node, depth, expanded, searching, onToggle }: TreeRowProps) {
    if (node.asset !== null) {
        return (
            <div
                style={{ paddingLeft: `${depth * 14 + 6}px` }}
                className="flex items-center gap-2 pr-3 py-1.5 rounded-lg hover:bg-surface-hover transition-colors"
            >
                <File className="w-3.5 h-3.5 text-text-subtle shrink-0" />
                <span
                    className="text-xs font-mono flex-1 min-w-0 truncate text-text"
                    title={node.path}
                >
                    {node.name}
                </span>
                {node.asset.class !== null && (
                    <span className="px-1.5 py-0.5 rounded bg-surface-active border border-border text-[10px] text-text-subtle shrink-0">
                        {node.asset.class}
                    </span>
                )}
                <span className="text-xs text-text-muted tabular-nums shrink-0">
                    {formatPakSize(node.asset.size)}
                </span>
            </div>
        )
    }
    const isOpen = searching || expanded.has(node.path)
    const fileCount = countFiles(node)
    return (
        <div>
            <button
                onClick={() => onToggle(node.path)}
                style={{ paddingLeft: `${depth * 14 + 6}px` }}
                className="flex items-center gap-2 w-full pr-3 py-1.5 rounded-lg hover:bg-surface-hover transition-colors text-left"
            >
                <ChevronRight
                    className={`w-3.5 h-3.5 text-text-subtle shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
                <Folder className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="text-xs font-medium flex-1 min-w-0 truncate text-text">
                    {node.name}
                </span>
                <span className="text-xs text-text-muted tabular-nums shrink-0">{fileCount}</span>
            </button>
            {isOpen &&
                node.children.map((child) => (
                    <TreeRow
                        key={child.path}
                        node={child}
                        depth={depth + 1}
                        expanded={expanded}
                        searching={searching}
                        onToggle={onToggle}
                    />
                ))}
        </div>
    )
}

export function PakViewerModal({ modName, uid, gameId, onClose }: Props) {
    const [assets, setAssets] = useState<PakAsset[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    useEffect(() => {
        let cancelled = false
        api.listPakAssets(gameId, uid)
            .then((rows) => {
                if (!cancelled) setAssets(rows)
            })
            .catch((e) => {
                if (!cancelled) setError(String(e))
            })
        return () => {
            cancelled = true
        }
    }, [gameId, uid])

    const q = query.trim().toLowerCase()
    const tree = useMemo(() => (assets ? buildTree(assets) : null), [assets])
    const visibleTree = useMemo(() => {
        if (tree === null) return null
        if (q === '') return tree
        return filterTree(tree, q)
    }, [tree, q])

    const searching = q !== ''
    const matchCount = visibleTree === null ? 0 : countFiles(visibleTree)
    const hasMatches = searching ? matchCount > 0 : (assets?.length ?? 0) > 0

    const toggle = (path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
            }
            return next
        })
    }

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onClose()}
            title={t('installed.pakViewer.title')}
            size="list"
            className="w-[56rem] max-w-[92vw] text-text"
            onOpenAutoFocus={(e) => e.preventDefault()}
        >
            <DialogHeader
                title={t('installed.pakViewer.title')}
                subtitle={modName}
                icon={<FileArchive className="w-4 h-4 text-accent" />}
                onClose={onClose}
            />

            <div className="flex items-center gap-2 px-3 pt-3 shrink-0">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('installed.pakViewer.searchPlaceholder')}
                        className={`w-full text-xs pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${query ? 'pr-7' : 'pr-3'}`}
                    />
                    {query && <SearchClearButton onClick={() => setQuery('')} />}
                </div>
                {assets !== null && (
                    <span className="text-xs text-text-muted shrink-0">
                        {searching
                            ? t('installed.pakViewer.matchCount', {
                                  count: matchCount,
                                  total: assets.length,
                              })
                            : t('installed.pakViewer.assetCount', { count: assets.length })}
                    </span>
                )}
            </div>

            <div className="overflow-y-auto flex-1 p-3 flex flex-col gap-0.5">
                {error !== null && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text flex flex-col gap-1">
                        <span className="flex items-center gap-2 font-medium">
                            <TriangleAlert className="w-4 h-4 shrink-0" />
                            {t('installed.pakViewer.error')}
                        </span>
                        <span className="text-xs break-words">{error}</span>
                        <span className="text-xs text-text-muted">
                            {t('installed.pakViewer.aesHint')}
                        </span>
                    </div>
                )}
                {error === null && assets === null && (
                    <div className="flex items-center justify-center gap-2 py-10 text-text-subtle text-sm">
                        <Loader className="w-4 h-4 animate-spin shrink-0" />
                        {t('installed.pakViewer.loading')}
                    </div>
                )}
                {error === null && assets !== null && !hasMatches && (
                    <div className="flex items-center justify-center py-8 text-text-subtle text-sm">
                        {assets.length === 0
                            ? t('installed.pakViewer.empty')
                            : t('installed.pakViewer.noMatches', { query: query.trim() })}
                    </div>
                )}
                {error === null && visibleTree !== null && hasMatches && (
                    <div>
                        {visibleTree.children.map((child) => (
                            <TreeRow
                                key={child.path}
                                node={child}
                                depth={0}
                                expanded={expanded}
                                searching={searching}
                                onToggle={toggle}
                            />
                        ))}
                    </div>
                )}
            </div>
        </Dialog>
    )
}

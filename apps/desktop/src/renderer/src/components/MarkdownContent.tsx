import { lazy, Suspense } from 'react'
import { SkeletonText } from './Skeleton'

const loadImpl = () => import('./MarkdownContentImpl')
const MarkdownImpl = lazy(() => loadImpl().then((m) => ({ default: m.MarkdownContent })))
const ModworkshopImpl = lazy(() => loadImpl().then((m) => ({ default: m.ModworkshopMarkup })))

// warm the chunk during startup idle so the null fallback window rarely ever shows
setTimeout(() => void loadImpl(), 2000)

// Plain markdown, for text that isn't ModWorkshop's, like release notes.
export function MarkdownContent(props: { text: string }) {
    return (
        <Suspense fallback={<SkeletonText />}>
            <MarkdownImpl {...props} />
        </Suspense>
    )
}

// Mod text from ModWorkshop, in its own markdown dialect.
export function ModworkshopMarkup(props: { text: string; onOpenDetail?: (modId: number) => void }) {
    return (
        <Suspense fallback={<SkeletonText />}>
            <ModworkshopImpl {...props} />
        </Suspense>
    )
}

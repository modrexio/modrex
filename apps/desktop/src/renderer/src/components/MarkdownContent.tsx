import { lazy, Suspense } from 'react'
import { SkeletonText } from './Skeleton'

const loadImpl = () => import('./MarkdownContentImpl')
const MarkdownImpl = lazy(() => loadImpl().then((m) => ({ default: m.MarkdownContent })))
const ModworkshopImpl = lazy(() => loadImpl().then((m) => ({ default: m.ModworkshopMarkup })))

// warm the chunk during startup idle so the null fallback window rarely ever shows
setTimeout(() => void loadImpl(), 2000)

export function MarkdownContent(props: { text: string }) {
    return (
        <Suspense fallback={<SkeletonText />}>
            <MarkdownImpl {...props} />
        </Suspense>
    )
}

export function ModworkshopMarkup(props: {
    text: string
    legacy?: boolean
    onOpenDetail?: (modId: number) => void
}) {
    return (
        <Suspense fallback={<SkeletonText />}>
            <ModworkshopImpl {...props} />
        </Suspense>
    )
}

import { lazy, Suspense } from 'react'
import { SkeletonText } from './Skeleton'

const Impl = lazy(() =>
    import('./MarkdownContentImpl').then((m) => ({ default: m.MarkdownContent }))
)

// warm the chunk during startup idle so the null fallback window rarely ever shows
setTimeout(() => void import('./MarkdownContentImpl'), 2000)

export function MarkdownContent(props: { text: string; onOpenDetail?: (modId: number) => void }) {
    return (
        <Suspense fallback={<SkeletonText />}>
            <Impl {...props} />
        </Suspense>
    )
}

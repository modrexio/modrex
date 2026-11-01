import { SkeletonBar } from './Skeleton'

export function SkeletonListRow() {
    return (
        <div
            className="flex items-stretch rounded-lg border border-border bg-surface-raised overflow-hidden animate-pulse"
            aria-hidden="true"
        >
            <SkeletonBar className="shrink-0 w-28 rounded-none" />
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-2">
                <SkeletonBar className="h-3 w-2/3" />
                <SkeletonBar className="h-2.5 w-1/3" />
                <SkeletonBar className="h-2.5 w-1/4" />
            </div>
            <div className="flex items-center gap-2 px-4 shrink-0">
                <SkeletonBar className="w-9 h-5 rounded-[calc(10px*var(--modrex-radius-scale))]" />
                <SkeletonBar className="w-8 h-8" />
            </div>
        </div>
    )
}

import type { ModImage } from '../../../../shared/types'
import { useThumbnail } from '../../hooks/useThumbnail'
import { t } from '../../i18n'
import { SkeletonBar } from '../Skeleton'

export function LightboxImage({ file }: { file: string }) {
    const src = useThumbnail(file, 'full')
    if (!src) return null
    return (
        <img
            src={src}
            alt=""
            className="max-w-[calc(100%-8rem)] max-h-[calc(100%-6rem)] object-contain rounded"
            onClick={(e) => e.stopPropagation()}
        />
    )
}

// Full-size: gallery tiles render wider than the 256 px small variant.
function GalleryImage({ file }: { file: string }) {
    const src = useThumbnail(file, 'full')
    return src ? (
        <img src={src} alt="" loading="lazy" className="w-full h-40 object-cover" />
    ) : (
        <div className="w-full h-40 bg-surface-raised" />
    )
}

export function ImagesTab({
    images,
    loading,
    onOpenImage,
}: {
    images: ModImage[]
    loading: boolean
    onOpenImage: (index: number) => void
}) {
    if (loading) {
        return (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3 animate-pulse" aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="rounded-lg overflow-hidden border border-border">
                        <SkeletonBar className="w-full h-40 rounded-none" />
                    </div>
                ))}
            </div>
        )
    }

    if (images.length === 0) {
        return <p className="text-sm text-text-subtle">{t('detail.images.none')}</p>
    }
    return (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {images.map((img, i) => (
                <button
                    key={img.id}
                    onClick={() => onOpenImage(i)}
                    className="rounded-lg overflow-hidden border border-border hover:border-accent transition-colors focus:outline-none"
                >
                    <GalleryImage file={img.file} />
                </button>
            ))}
        </div>
    )
}

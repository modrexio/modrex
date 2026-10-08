import type { GameSpec } from '@modrex/games'

export const SUPPORTED_FORMATS = new Set(['pak', 'zip', '7z', 'rar', 'pdmod'])

export function isUnsupportedFormat(
    game: Pick<GameSpec, 'movieReplacement' | 'configPresets'>,
    type: string | null | undefined,
    downloadUrl?: string | null,
    sourceFilename?: string | null
): boolean {
    const normalized = type?.toLowerCase()
    if (normalized && normalized !== 'bk2' && normalized !== 'ini')
        return !SUPPORTED_FORMATS.has(normalized)

    const url = downloadUrl && URL.canParse(downloadUrl) ? new URL(downloadUrl) : null
    const pathFilename = url?.pathname.split('/').pop() ?? ''
    const pathDot = pathFilename.lastIndexOf('.')
    const hasPathExtension = pathDot >= 0 && pathDot < pathFilename.length - 1
    const filename = (
        url?.searchParams.get('filename') ||
        (hasPathExtension ? pathFilename : sourceFilename || pathFilename)
    )
        .split(/[\\/]/)
        .at(-1)!
        .toLowerCase()
    const dot = filename.lastIndexOf('.')
    const extension = normalized || filename.slice(dot + 1)
    if (extension === 'bk2') return !game.movieReplacement
    if (extension === 'ini')
        return !game.configPresets || filename !== game.configPresets.filename.toLowerCase()
    if (filename.endsWith('.tar.gz') || filename.endsWith('.tar.xz')) return false
    if (dot < 0 || dot === filename.length - 1) return false
    return !SUPPORTED_FORMATS.has(extension)
}

// Registry of video embed platforms used by MarkdownContent to detect and render inline players

export interface EmbedDef {
    type: string
    detect: (url: string) => string | null
    thumbnailUrl?: (id: string) => string
    embedUrl: (id: string) => string
    watchUrl: (id: string) => string
    height?: number
}

export interface Embed {
    def: EmbedDef
    id: string
}

export const YOUTUBE_EMBED: EmbedDef = {
    type: 'youtube',
    detect(url) {
        const patterns = [
            /youtu\.be\/([^/?&]+)/,
            /youtube(?:-nocookie)?\.com\/embed\/([^/?&]+)/,
            /youtube(?:-nocookie)?\.com\/watch\?(?:[^&]*&)*v=([^/?&]+)/,
        ]
        for (const p of patterns) {
            const m = url.match(p)
            if (m) return m[1]
        }
        return null
    },
    thumbnailUrl: (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    embedUrl: (id) => `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
    watchUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
}

const streamable: EmbedDef = {
    type: 'streamable',
    detect(url) {
        const m = url.match(/streamable\.com\/(?:[es]\/)?([a-zA-Z0-9]+)(?:[?#].*)?$/)
        return m ? m[1] : null
    },
    thumbnailUrl: (id) => `https://cdn-cf-east.streamable.com/image/${id}.jpg`,
    embedUrl: (id) => `https://streamable.com/e/${id}`,
    watchUrl: (id) => `https://streamable.com/${id}`,
}

const vimeo: EmbedDef = {
    type: 'vimeo',
    detect(url) {
        const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)
        return m ? m[1] : null
    },
    embedUrl: (id) => `https://player.vimeo.com/video/${id}?autoplay=1`,
    watchUrl: (id) => `https://vimeo.com/${id}`,
}

const soundcloud: EmbedDef = {
    type: 'soundcloud',
    detect(url) {
        const m = url.match(/soundcloud\.com\/([\w-]+\/[\w-]+)/)
        return m ? m[1] : null
    },
    embedUrl: (id) =>
        `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${id}`)}&auto_play=true`,
    watchUrl: (id) => `https://soundcloud.com/${id}`,
    height: 166,
}

export const EMBEDS: EmbedDef[] = [YOUTUBE_EMBED, streamable, vimeo, soundcloud]

const AUDIO_EXTENSIONS = ['aac', 'm4a', 'mp3', 'oga', 'ogg', 'wav']
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'ogv', 'webm', 'mpg', 'mpeg', 'avi']

export function mediaKind(url: string): 'audio' | 'video' | null {
    const ext = /\.([^/.]+)$/.exec(url)?.[1].toLowerCase()
    if (!ext) return null
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
    return null
}

export function detectEmbed(src: string, defs = EMBEDS): Embed | null {
    // Normalize double-protocol bug: "https://https://youtu.be/..." becomes "https://youtu.be/..."
    const url = src.replace(/^https?:\/\/https?:\/\//, 'https://')
    for (const def of defs) {
        const id = def.detect(url)
        if (id !== null) return { def, id }
    }
    return null
}

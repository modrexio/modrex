import { useState } from 'react'
import { t } from '../i18n'
import type { Embed } from '../embeds'

export function EmbedPlayer({ embed }: { embed: Embed }) {
    const [playing, setPlaying] = useState(false)
    const { def, id } = embed

    return (
        <div className="my-3 overflow-hidden border border-border bg-surface max-w-xl">
            <div
                className="relative"
                style={def.height ? { height: def.height } : { aspectRatio: '16 / 9' }}
            >
                {playing ? (
                    <iframe
                        src={def.embedUrl(id)}
                        className="absolute inset-0 w-full h-full"
                        style={{ border: 'none' }}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                    />
                ) : (
                    <>
                        {def.thumbnailUrl && (
                            <img
                                src={def.thumbnailUrl(id)}
                                alt={t('embed.videoThumbnail')}
                                draggable={false}
                                className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                            />
                        )}
                        <button
                            className="absolute inset-0 flex items-center justify-center group"
                            onClick={() => setPlaying(true)}
                            aria-label={t('embed.play')}
                        >
                            <div className="absolute inset-0 bg-black/10 group-hover:bg-black/30 transition-colors duration-150" />
                            <div className="relative flex items-center justify-center w-14 h-14 bg-black/50 rounded-full shadow-2xl group-hover:scale-105 group-hover:bg-black/70 transition-all duration-150">
                                <svg
                                    className="w-6 h-6 text-white"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                >
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            </div>
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}

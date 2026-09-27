import { getImage } from 'astro:assets'
import browseMods from '../assets/screenshots/browse-mods-window.png'

// Derived from the screenshot rather than pointing at it: the source is a 1MB 1706px
// PNG, and scrapers that fetch og:image commonly give up on files that size. Generated
// at build time so it can never drift from the screenshot it is cut from. JPEG, not
// PNG, because Astro's PNG encoder does not quantize and lands around 780kB here;
// scrapers are the one audience with no WebP or AVIF guarantee. Astro deduplicates the
// transform, so every page calling this shares one generated file.
export function getOgImage() {
    return getImage({
        src: browseMods,
        width: 1200,
        height: 630,
        fit: 'cover',
        position: 'top',
        format: 'jpeg',
        quality: 82,
    })
}

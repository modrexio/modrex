export type Platform = 'windows' | 'linux'

// Shared client-side OS detection for the download buttons in Hero, DownloadSection, and Nav.
// Returns null wherever no Modrex installer runs (phones, tablets, macOS, ChromeOS).
// Android and ChromeOS user agents both carry Linux or X11.
export function detectPlatform(): Platform | null {
    const ua = navigator.userAgent
    if (/Windows/.test(ua)) return 'windows'
    if (/Linux|X11/.test(ua) && !/Android|CrOS/.test(ua)) return 'linux'
    return null
}

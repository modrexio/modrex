export const LIBRARY_PROFILES = {
    empty: 'Empty library',
    demo: 'Six mods covering folders, disabled, missing and outdated states',
    large: '120 generated entries for layout and interaction stress testing',
} as const

export const NETWORK_MODES = {
    online: 'Normal fixture responses',
    offline: 'Every remote request fails',
    slow: 'Remote requests and downloads are delayed',
} as const

export const GAME_STATES = {
    detected: 'Every supported game is detected',
    missing: 'No game installation is found',
} as const

export const ONBOARDING_STATES = {
    configured: 'Existing installation',
    'first-run': 'Welcome screen and telemetry consent',
} as const

type Option<T> = Extract<keyof T, string>

export type LibraryProfile = Option<typeof LIBRARY_PROFILES>
export type NetworkMode = Option<typeof NETWORK_MODES>
export type GameState = Option<typeof GAME_STATES>
export type OnboardingState = Option<typeof ONBOARDING_STATES>

export type PreviewState = {
    library: LibraryProfile
    network: NetworkMode
    games: GameState
    onboarding: OnboardingState
}

export const DEFAULT_PREVIEW_STATE: PreviewState = {
    library: 'empty',
    network: 'online',
    games: 'detected',
    onboarding: 'configured',
}

const LEGACY_SCENARIOS = {
    default: DEFAULT_PREVIEW_STATE,
    library: { ...DEFAULT_PREVIEW_STATE, library: 'demo' },
    'no-game': { ...DEFAULT_PREVIEW_STATE, games: 'missing' },
    offline: { ...DEFAULT_PREVIEW_STATE, network: 'offline' },
    slow: { ...DEFAULT_PREVIEW_STATE, network: 'slow' },
    'first-run': { ...DEFAULT_PREVIEW_STATE, onboarding: 'first-run' },
} satisfies Record<string, PreviewState>

const STATE_PARAMETERS = ['library', 'network', 'games', 'onboarding'] as const
const LATENCY_MS = 2500

function readOption<const Options extends Record<string, string>>(
    params: URLSearchParams,
    name: string,
    options: Options,
    fallback: Option<Options>
): Option<Options> {
    const requested = params.get(name)
    if (requested === null) return fallback
    if (!Object.hasOwn(options, requested)) throw new Error(`preview: unknown ${name} ${requested}`)
    return requested as Option<Options>
}

function readPreviewState(): PreviewState {
    const params = new URLSearchParams(window.location.search)
    const legacyName = params.get('scenario')
    if (legacyName === null) {
        return {
            library: readOption(params, 'library', LIBRARY_PROFILES, 'empty'),
            network: readOption(params, 'network', NETWORK_MODES, 'online'),
            games: readOption(params, 'games', GAME_STATES, 'detected'),
            onboarding: readOption(params, 'onboarding', ONBOARDING_STATES, 'configured'),
        }
    }

    if (STATE_PARAMETERS.some((name) => params.has(name))) {
        throw new Error('preview: scenario cannot be combined with preview state parameters')
    }
    if (!Object.hasOwn(LEGACY_SCENARIOS, legacyName)) {
        throw new Error(`preview: unknown scenario ${legacyName}`)
    }
    return { ...LEGACY_SCENARIOS[legacyName as keyof typeof LEGACY_SCENARIOS] }
}

export const previewState = readPreviewState()

export async function remote(path: string) {
    if (previewState.network === 'offline') {
        throw new Error(
            `error sending request for url (https://api.modworkshop.net${path}): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution`
        )
    }
    if (previewState.network === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
    }
}

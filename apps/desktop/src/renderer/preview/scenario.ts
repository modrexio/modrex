export const SCENARIOS = {
    default: 'Every game detected, empty library',
    library: 'A populated library with a folder, a disabled mod, a missing file and an update',
    'no-game': 'No game installation found',
    offline: 'modworkshop unreachable',
    slow: 'Every request takes seconds, downloads take longer',
    'first-run': 'Fresh install: welcome screen and telemetry consent',
} as const

export type Scenario = keyof typeof SCENARIOS

const LATENCY_MS = 2500

export function scenario(): Scenario {
    const requested = new URLSearchParams(window.location.search).get('scenario')
    if (requested === null) return 'default'
    if (!(requested in SCENARIOS)) throw new Error(`preview: unknown scenario ${requested}`)
    return requested as Scenario
}

export async function remote(path: string) {
    if (scenario() === 'offline') {
        throw new Error(
            `error sending request for url (https://api.modworkshop.net${path}): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution`
        )
    }
    if (scenario() === 'slow') await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
}

// Transparent passthrough to GA4's Measurement Protocol endpoint, used by the desktop
// app's opt-in analytics (apps/desktop/src-tauri/src/commands/analytics.rs, which
// documents why sending from Rust is not enough on its own).
//
// Routing through modrex.net means the request only has to survive being blocked by this
// name, not by Google's: DNS-level and hosts-file blocklists (Pi-hole, AdGuard Home,
// NextDNS) block google-analytics.com for every process on a machine, and this audience
// runs that tooling heavily.
//
// The body is forwarded verbatim, so this never drifts out of sync with whatever
// analytics.rs sends. The one exception is ip_override below: without it GA4
// geolocates every user to wherever this function's outbound fetch egresses from
// (Cloudflare's network) rather than to the real visitor.
export async function onRequestPost({
    request,
    env,
    waitUntil,
}: {
    request: Request
    env: { MODREX_GA_MEASUREMENT_ID?: string; MODREX_GA_API_SECRET?: string }
    waitUntil: (promise: Promise<unknown>) => void
}): Promise<Response> {
    // Only the proxy holds the GA4 secret. Older desktop releases still send one in the
    // query string and it is ignored.
    const apiSecret = env.MODREX_GA_API_SECRET
    if (!apiSecret) {
        console.error('Analytics relay is missing the MODREX_GA_API_SECRET binding')
        return new Response('Analytics relay is not configured', { status: 503 })
    }
    const incoming = new URL(request.url)
    const measurementId = incoming.searchParams.get('measurement_id')
    if (!measurementId) {
        return new Response('Missing measurement_id', { status: 400 })
    }
    // Relay only to Modrex's own GA4 property so modrex.net can't be used as a generic,
    // unauthenticated relay into arbitrary GA4 accounts. The exact id is a build-time secret in
    // the desktop app (analytics.rs option_env MODREX_GA_MEASUREMENT_ID), so pin it here only
    // when that same value is set as a Pages env var; otherwise fall back to requiring a
    // well-formed GA4 id. measurement_id is not itself secret (it rides in every GA request).
    const expectedId = env.MODREX_GA_MEASUREMENT_ID
    const idAllowed = expectedId
        ? measurementId === expectedId
        : /^G-[A-Z0-9]{4,}$/.test(measurementId)
    if (!idAllowed) {
        return new Response('Unexpected measurement_id', { status: 403 })
    }

    const target = new URL('https://www.google-analytics.com/mp/collect')
    target.searchParams.set('measurement_id', measurementId)
    target.searchParams.set('api_secret', apiSecret)

    // Set by Cloudflare's edge itself from the real TCP connection, so the client
    // can't spoof this by sending its own header, Cloudflare overwrites it.
    // Absent under local wrangler pages dev, where no real edge is involved. The
    // request still forwards without geo correction.
    const clientIp = request.headers.get('CF-Connecting-IP')
    let body: unknown
    try {
        body = await request.json()
    } catch {
        return new Response('Invalid JSON', { status: 400 })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return new Response('Expected a JSON object', { status: 400 })
    }
    if (clientIp) Object.assign(body, { ip_override: clientIp })

    // A 204 acknowledges receipt by the proxy, not acceptance into GA4 reports.
    // Keep delivery off the app's critical path and record upstream failures in Pages logs.
    waitUntil(
        fetch(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': request.headers.get('User-Agent') ?? '',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        })
            .then((response) => {
                if (!response.ok) {
                    console.error('Analytics upstream rejected request', {
                        status: response.status,
                    })
                }
                return response.body?.cancel()
            })
            .catch(() => {
                // Fetch errors can contain the target URL and its API secret.
                console.error('Analytics upstream delivery failed')
            })
    )

    return new Response(null, { status: 204 })
}

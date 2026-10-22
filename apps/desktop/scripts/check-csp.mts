import { readFileSync } from 'fs'

// tauri.conf.json carries two Content-Security-Policies: csp (production) and devCsp
// (dev, relaxed for Vite HMR). Every external resource origin - image host, embed
// provider, web font, renderer fetch target - must appear in BOTH, or it loads in one
// mode and fails silently in the other (blank images, dead embeds). devCsp is allowed
// exactly two kinds of extra source: the unsafe-inline / unsafe-eval script relaxations
// and localhost / 127.0.0.1 dev-server origins. Any other divergence is a real mistake.

type TauriConf = { app?: { security?: { csp?: unknown; devCsp?: unknown } } }

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as TauriConf
const csp = conf.app?.security?.csp
const devCsp = conf.app?.security?.devCsp
if (typeof csp !== 'string' || typeof devCsp !== 'string') {
    console.error('check-csp: csp or devCsp missing from src-tauri/tauri.conf.json app.security')
    process.exit(1)
}

function parse(policy: string) {
    const directives = new Map<string, Set<string>>()
    for (const clause of policy.split(';')) {
        const [name, ...sources] = clause.trim().split(/\s+/)
        if (name) directives.set(name, new Set(sources))
    }
    return directives
}

function isDevOnly(token: string) {
    return (
        token === "'unsafe-inline'" ||
        token === "'unsafe-eval'" ||
        /^(ws|wss|http|https):\/\/(localhost|127\.0\.0\.1)(:(\*|\d+))?$/.test(token)
    )
}

const prod = parse(csp)
const dev = parse(devCsp)
const problems: string[] = []

for (const [directive, sources] of prod) {
    const devSources = dev.get(directive)
    if (!devSources) {
        problems.push(`devCsp is missing the "${directive}" directive that csp declares`)
        continue
    }
    for (const src of sources) {
        if (!devSources.has(src)) problems.push(`csp "${directive}" has ${src} but devCsp does not`)
    }
}

for (const [directive, sources] of dev) {
    const prodSources = prod.get(directive)
    for (const src of sources) {
        if (isDevOnly(src)) continue
        if (!prodSources?.has(src))
            problems.push(`devCsp "${directive}" has ${src} but csp does not`)
    }
}

if (problems.length > 0) {
    console.error('check-csp: csp and devCsp diverge on non-dev-only sources:')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
}
console.log(`check-csp: ${prod.size} directives, csp and devCsp agree on all external origins`)

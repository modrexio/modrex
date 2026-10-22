import { readFileSync } from 'fs'

type Manifest = {
    overrides?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
}

const root = JSON.parse(readFileSync('../../package.json', 'utf8')) as Manifest & {
    workspaces: string[]
}
const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const manifests = ['../../package.json']
for (const pattern of root.workspaces) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync('../..')) {
        manifests.push(`../../${path}`)
    }
}

const problems: string[] = []
for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest
    const declared: Record<string, string> = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
    }
    for (const [name, override] of Object.entries(root.overrides ?? {})) {
        const spec = declared[name]
        if (!spec) continue
        // Two ranges cannot be compared without resolving, so only a pin on one side is checked.
        const conflicts = exact.test(override)
            ? !Bun.semver.satisfies(override, spec)
            : exact.test(spec) && !Bun.semver.satisfies(spec, override)
        if (conflicts) {
            problems.push(
                `${manifest.slice(6)} asks for ${name} ${spec}, but the root override forces ${override}`
            )
        }
    }
}

if (problems.length > 0) {
    console.error('Override check failed:')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('Update or remove the override in package.json so it agrees with the workspace.')
    process.exit(1)
}

console.log(`Override check passed: ${manifests.length} manifests agree with the root overrides`)

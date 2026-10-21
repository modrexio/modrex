// GitHub's dependency graph does not read bun.lock, so CI submits it as a snapshot.
type Dependencies = Record<string, string>
type Workspace = {
    name?: string
    dependencies?: Dependencies
    devDependencies?: Dependencies
    optionalDependencies?: Dependencies
    peerDependencies?: Dependencies
}
type Lockfile = {
    lockfileVersion: number
    workspaces: Record<string, Workspace>
    packages: Record<string, [spec: string, registry?: string, ...rest: unknown[]]>
}

const lockPath = new URL('../../bun.lock', import.meta.url)
const lock = Bun.JSONC.parse(await Bun.file(lockPath).text()) as Lockfile
const env = process.env

// bun.lock keys a workspace's own copy of a dependency as workspace-name/dependency.
const direct = new Set(
    Object.values(lock.workspaces).flatMap((workspace) =>
        Object.keys({
            ...workspace.dependencies,
            ...workspace.devDependencies,
            ...workspace.optionalDependencies,
            ...workspace.peerDependencies,
        }).flatMap((name) => [name, `${workspace.name}/${name}`])
    )
)

const resolved: Record<string, { package_url: string; relationship: 'direct' | 'indirect' }> = {}
for (const [key, [spec, registry]] of Object.entries(lock.packages)) {
    if (spec.includes('@workspace:')) continue
    if (typeof registry !== 'string') {
        throw new Error(`bun.lock entry ${key} (${spec}) is not a registry package`)
    }

    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const id = `${name}@${version}`
    if (resolved[id]?.relationship === 'direct') continue

    resolved[id] = {
        package_url: `pkg:npm/${name.replace(/^@/, '%40')}@${version}`,
        relationship: direct.has(key) ? 'direct' : 'indirect',
    }
}

const snapshot = {
    version: 0,
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    job: { correlator: `${env.GITHUB_WORKFLOW} ${env.GITHUB_JOB}`, id: env.GITHUB_RUN_ID },
    detector: {
        name: 'bun-lock-snapshot',
        version: String(lock.lockfileVersion),
        url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
    },
    scanned: new Date().toISOString(),
    manifests: {
        'bun.lock': { name: 'bun.lock', file: { source_location: 'bun.lock' }, resolved },
    },
}

console.log(JSON.stringify(snapshot))

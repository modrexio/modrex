import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = path.join(desktopRoot, 'pakviewer')
const output = path.join(desktopRoot, 'src-tauri', 'resources', 'pakviewer')
const rid = process.platform === 'win32' ? 'win-x64' : 'linux-x64'

// Published single-file and self-contained: the bundled runtime is what makes the
// sidecar run on a user's machine without any .NET install. dotnet publish wipes the
// output directory, so a fresh dist/ holds exactly the current build.
const result = spawnSync(
    'dotnet',
    [
        'publish',
        project,
        '-c',
        'Release',
        '-r',
        rid,
        '--self-contained',
        'true',
        '-p:PublishSingleFile=true',
        '-p:PublishTrimmed=false',
        '-p:EnableCompressionInSingleFile=true',
        '-p:DebugType=None',
        '-p:DebugSymbols=false',
        '-o',
        output,
    ],
    { stdio: 'inherit' }
)

process.exit(result.status ?? 1)

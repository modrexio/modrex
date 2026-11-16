import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseUrl = 'https://index.modrex.net/preview/'
const fixturesDir = fileURLToPath(new URL('../src/renderer/preview/fixtures/', import.meta.url))

async function download(path: string): Promise<Response> {
    const url = new URL(path, baseUrl)
    const response = await fetch(url).catch((cause: unknown) => {
        throw new Error(`Failed to download ${url}`, { cause })
    })
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    }
    return response
}

// The refresh workflow tests a fresh export before uploading it, so the download must not overwrite it.
if (process.env.PREVIEW_FIXTURES_READY !== '1') {
    const manifest: unknown = await (await download('manifest.json')).json()
    if (
        !Array.isArray(manifest) ||
        manifest.length === 0 ||
        !manifest.every(
            (path): path is string =>
                typeof path === 'string' && /^(?:[\w-]+\/)*[\w-]+\.json$/.test(path)
        )
    ) {
        throw new Error(`Invalid fixture manifest at ${baseUrl}manifest.json`)
    }
    for (const path of manifest) {
        const response = await download(path)
        const destination = join(fixturesDir, path)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, new Uint8Array(await response.arrayBuffer()))
    }
}

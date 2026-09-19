import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    buildPrelude,
    parseSemver,
    resolveEngineTag,
    shellQuote,
    type InstallConfig,
} from './install.sh'

describe('shellQuote', () => {
    it('wraps a plain value in single quotes', () => {
        expect(shellQuote('modrex')).toBe("'modrex'")
    })

    it('escapes embedded single quotes so a value cannot break out into shell code', () => {
        // The injection barrier: close the quote, emit an escaped quote, reopen.
        expect(shellQuote("a'b")).toBe(`'a'"'"'b'`)
        expect(shellQuote("'; rm -rf / #")).toBe(`''"'"'; rm -rf / #'`)
    })

    it('renders null and undefined as an empty quoted string', () => {
        expect(shellQuote(null)).toBe("''")
        expect(shellQuote(undefined)).toBe("''")
    })

    it('stringifies non-string scalars', () => {
        expect(shellQuote(0)).toBe("'0'")
        expect(shellQuote(true)).toBe("'true'")
    })
})

describe('parseSemver', () => {
    it('parses a well-formed vMAJOR.MINOR.PATCH tag', () => {
        expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    })

    it('rejects tags that are not exactly three numeric segments with a v prefix', () => {
        expect(parseSemver('v1')).toBeNull()
        expect(parseSemver('v1.2')).toBeNull()
        expect(parseSemver('1.2.3')).toBeNull()
        expect(parseSemver('v1.2.3-rc1')).toBeNull()
        expect(parseSemver('latest')).toBeNull()
    })
})

describe('resolveEngineTag', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    function stubTags(names: string[]) {
        const fetchMock = vi.fn(
            async () => new Response(JSON.stringify(names.map((name) => ({ name }))))
        )
        vi.stubGlobal('fetch', fetchMock)
        return fetchMock
    }

    it('returns an exact tag without hitting the API', async () => {
        const fetchMock = stubTags([])
        expect(await resolveEngineTag('v1.1.0')).toBe('v1.1.0')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('resolves a bare major to the highest matching minor/patch', async () => {
        stubTags(['v1.0.0', 'v1.2.0', 'v1.1.9', 'v2.0.0'])
        expect(await resolveEngineTag('v1')).toBe('v1.2.0')
    })

    it('never crosses into a higher major for a bare-major pin', async () => {
        stubTags(['v1.4.0', 'v2.0.0', 'v3.1.0'])
        expect(await resolveEngineTag('v1')).toBe('v1.4.0')
    })

    it('resolves "latest" to the highest semver across all majors', async () => {
        stubTags(['v1.9.0', 'v2.0.1', 'v2.0.0'])
        expect(await resolveEngineTag('latest')).toBe('v2.0.1')
    })

    it('throws on an unparseable pin', async () => {
        stubTags(['v1.0.0'])
        await expect(resolveEngineTag('garbage')).rejects.toThrow('invalid ENGINE_PIN')
    })

    it('throws when no tag matches the requested major', async () => {
        stubTags(['v2.0.0', 'v3.0.0'])
        await expect(resolveEngineTag('v1')).rejects.toThrow('no tags found')
    })
})

describe('buildPrelude', () => {
    const config: InstallConfig = {
        schema_version: 1,
        project_name: 'modrex',
        manifest_url: 'https://example.com/manifest.json',
        install_dir: '/opt/modrex',
        preferred_variant: { linux: 'appimage', macos: 'dmg' },
    }

    it('emits uppercased CFG_ exports for every config key', () => {
        const prelude = buildPrelude(config)
        expect(prelude).toContain("CFG_PROJECT_NAME='modrex'")
        expect(prelude).toContain("CFG_INSTALL_DIR='/opt/modrex'")
        expect(prelude).toContain("CFG_SCHEMA_VERSION='1'")
    })

    it('flattens preferred_variant into space-separated os:variant pairs', () => {
        expect(buildPrelude(config)).toContain("CFG_PREFERRED_VARIANT='linux:appimage macos:dmg'")
    })

    it('forwards keys it has never heard of, so the schema lives in mget alone', () => {
        expect(buildPrelude({ ...config, command_name: 'modrex' })).toContain(
            "CFG_COMMAND_NAME='modrex'"
        )
    })

    it('omits keys the config does not set instead of inventing defaults', () => {
        expect(buildPrelude(config)).not.toContain('CFG_PUBKEY')
    })

    it('preserves boolean false', () => {
        expect(buildPrelude({ ...config, add_to_path: false })).toContain("CFG_ADD_TO_PATH='false'")
    })

    it('skips nested values and keys that cannot form a shell variable name', () => {
        const prelude = buildPrelude({
            ...config,
            nested: { a: 1 },
            list: [1],
            'bad-key': 'x',
            Upper: 'x',
        })
        expect(prelude).not.toContain('CFG_NESTED')
        expect(prelude).not.toContain('CFG_LIST')
        expect(prelude).not.toContain('BAD')
        expect(prelude).not.toContain('CFG_UPPER')
    })

    it('quotes a malicious config value instead of letting it become shell code', () => {
        const prelude = buildPrelude({ ...config, project_name: "x'; rm -rf / #" })
        expect(prelude).toContain(`CFG_PROJECT_NAME='x'"'"'; rm -rf / #'`)
    })
})

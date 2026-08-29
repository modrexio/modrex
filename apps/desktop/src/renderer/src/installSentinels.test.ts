import { describe, it, expect, vi } from 'vitest'
import type { InstallOutcome } from './api'
import { handleInstallOutcome, type InstallSentinelHandlers } from './installSentinels'

function makeHandlers(): InstallSentinelHandlers {
    return {
        onZipMultiPak: vi.fn(),
        onHostModPack: vi.fn(),
        onCbFlatArchive: vi.fn(),
        onUnrecognizedArchive: vi.fn(),
    }
}

const zipPayload = {
    archiveHandle: 'handle-a',
    entries: ['a.pak', 'b.pak'],
    targetTag: null,
    modId: 1,
    modName: 'A',
    fileId: 2,
    fileType: 'zip',
    modVersion: '1.0',
}

const hostPayload = {
    archiveHandle: 'handle-b',
    entries: ['Set One'],
    hostModId: 17160,
    hostName: 'Menu Backgrounds',
    hostSubpath: 'Assets',
    modId: 3,
    modName: 'B',
    fileId: 4,
    fileType: 'zip',
    modVersion: '1.0',
}

const cbFlatPayload = {
    archiveHandle: 'handle-c',
    modId: 5,
    modName: 'C',
    fileId: 6,
    fileType: 'zip',
    modVersion: '1.0',
}

describe('handleInstallOutcome', () => {
    it('returns false and calls nothing for a completed install', () => {
        const handlers = makeHandlers()
        expect(handleInstallOutcome('installed', handlers)).toBe(false)
        for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled()
    })

    it('routes a picker outcome to onZipMultiPak only', () => {
        const handlers = makeHandlers()
        const outcome = { needsPicker: zipPayload } as InstallOutcome
        expect(handleInstallOutcome(outcome, handlers)).toBe(true)
        expect(handlers.onZipMultiPak).toHaveBeenCalledWith(zipPayload)
        expect(handlers.onHostModPack).not.toHaveBeenCalled()
        expect(handlers.onCbFlatArchive).not.toHaveBeenCalled()
        expect(handlers.onUnrecognizedArchive).not.toHaveBeenCalled()
    })

    it('routes a host-pack outcome to onHostModPack only', () => {
        const handlers = makeHandlers()
        const outcome = { needsHostChoice: hostPayload } as InstallOutcome
        expect(handleInstallOutcome(outcome, handlers)).toBe(true)
        expect(handlers.onHostModPack).toHaveBeenCalledWith(hostPayload)
        expect(handlers.onZipMultiPak).not.toHaveBeenCalled()
    })

    it('routes a CB flat archive outcome to onCbFlatArchive only', () => {
        const handlers = makeHandlers()
        const outcome = { needsCbFlatConfirm: cbFlatPayload } as InstallOutcome
        expect(handleInstallOutcome(outcome, handlers)).toBe(true)
        expect(handlers.onCbFlatArchive).toHaveBeenCalledWith(cbFlatPayload)
        expect(handlers.onZipMultiPak).not.toHaveBeenCalled()
    })

    it('routes an unrecognized outcome to onUnrecognizedArchive only', () => {
        const handlers = makeHandlers()
        expect(handleInstallOutcome('unrecognized', handlers)).toBe(true)
        expect(handlers.onUnrecognizedArchive).toHaveBeenCalled()
        expect(handlers.onZipMultiPak).not.toHaveBeenCalled()
    })
})

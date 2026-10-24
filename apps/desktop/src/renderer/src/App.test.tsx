// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SourceInfo } from './api'

const mocks = vi.hoisted(() => ({
    sources: vi.fn(),
    path: vi.fn(),
    installed: vi.fn(),
    startup: vi.fn(),
    log: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-log', () => ({ error: mocks.log }))
vi.mock('./loaders', () => ({ loadLoaderRegistry: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./api', () => ({
    api: {
        listSources: mocks.sources,
        findGamePath: mocks.path,
        getInstalled: mocks.installed,
        reportStartupPhase: mocks.startup,
        updateDiscordPresence: vi.fn().mockResolvedValue(undefined),
        getAnalyticsConsent: vi.fn().mockResolvedValue(false),
        getGameSettings: vi.fn().mockResolvedValue({ launchOptions: '', launcher: 'steam' }),
        getDetectedInstalls: vi.fn().mockResolvedValue([]),
        windowIsMaximized: vi.fn().mockResolvedValue(false),
        windowStartResizeDragging: vi.fn().mockResolvedValue(undefined),
        onWindowResized: vi.fn(() => () => {}),
        onNxmInstallComplete: vi.fn(() => () => {}),
        observeInstalls: vi.fn(() => () => {}),
        onNxmResourceReview: vi.fn(() => () => {}),
        onUpdateAvailable: vi.fn(() => () => {}),
        onUpdateProgress: vi.fn(() => () => {}),
        onUpdateReady: vi.fn(() => () => {}),
        onSupportPromptEligible: vi.fn(() => () => {}),
        onNexusSessionExpired: vi.fn(() => () => {}),
        onNexusOAuthSignedIn: vi.fn(() => () => {}),
        onNexusOAuthCallbackReceived: vi.fn(() => () => {}),
        onNexusOAuthFailed: vi.fn(() => () => {}),
    },
}))

vi.mock('./components/Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./components/FileDropInstall', () => ({
    FileDropInstall: ({ children }: { children: ReactNode }) => children,
    useFileDropTarget: vi.fn(),
}))
vi.mock('./components/Dialog', () => ({ Dialog: () => null }))
vi.mock('./components/ResourceInstallDialog', () => ({ ResourceInstallDialog: () => null }))
vi.mock('./components/TelemetryConsentDialog', () => ({ TelemetryConsentDialog: () => null }))
vi.mock('./components/TopBar', () => ({ TopBar: () => null }))
vi.mock('./components/GameTopBar', () => ({ GameTopBar: () => null }))
vi.mock('./components/WelcomeScreen', () => ({
    WelcomeScreen: ({ onSelectGame }: { onSelectGame: (gameId: 'pd3') => void }) => (
        <div>
            <h1>Games</h1>
            <button onClick={() => onSelectGame('pd3')}>Select game</button>
        </div>
    ),
}))
vi.mock('./components/SettingsPage', () => ({
    SettingsPage: () => <h1>Global settings</h1>,
    saveSettingsTab: vi.fn(),
}))
vi.mock('./components/GameSettings', () => ({ GameSettings: () => null }))
vi.mock('./components/GameFolders', () => ({ GameFolders: () => null }))
vi.mock('./components/EngineIniSettings', () => ({ EngineIniSettings: () => null }))
vi.mock('./components/GraphicsConfigSettings', () => ({ GraphicsConfigSettings: () => null }))
vi.mock('./components/NewsPage', () => ({ NewsPage: () => null }))
vi.mock('./lib/analytics/useModIdentificationTracking', () => ({
    useModIdentificationTracking: vi.fn(),
}))
vi.mock('./components/InstalledPage', () => ({
    InstalledPage: ({ isActive }: { isActive: boolean }) => (
        <div data-testid="installed" data-active={isActive} />
    ),
}))
vi.mock('./components/BrowsePage', () => ({
    BrowsePage: ({
        isActive,
        onSourceChange,
    }: {
        isActive: boolean
        onSourceChange: (source: string) => void
    }) => (
        <div data-testid="modworkshop" data-active={isActive}>
            <button onClick={() => onSourceChange('nexus')}>Choose Nexus</button>
        </div>
    ),
}))
vi.mock('./components/NexusBrowsePage', () => ({
    NexusBrowsePage: ({
        isActive,
        onSourceChange,
    }: {
        isActive: boolean
        onSourceChange: (source: string) => void
    }) => (
        <div data-testid="nexus" data-active={isActive}>
            <button onClick={() => onSourceChange('modworkshop')}>Choose ModWorkshop</button>
        </div>
    ),
}))

const nexus: SourceInfo = {
    id: 'nexus',
    games: [{ gameId: 'pd3', nativeId: 'payday3' }],
}
const modworkshop: SourceInfo = {
    id: 'modworkshop',
    games: [{ gameId: 'pd3', nativeId: '853' }],
}

beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux')
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('modrex:scope', 'game')
    localStorage.setItem('modrex:active-game', 'pd3')
    mocks.sources.mockResolvedValue([modworkshop, nexus])
    mocks.path.mockResolvedValue('C:/Games/PAYDAY3')
    mocks.installed.mockResolvedValue({ mods: [], folders: [] })
    mocks.startup.mockResolvedValue(undefined)
    mocks.log.mockResolvedValue(undefined)
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

async function mount() {
    const { default: App } = await import('./App')
    return render(<App />)
}

function expectActive(source: 'nexus' | 'modworkshop' | 'installed') {
    expect(screen.getByTestId(source).getAttribute('data-active')).toBe('true')
}

test('restored workspace waits for sources and preserves a valid saved Nexus selection', async () => {
    localStorage.setItem('modrex:pd3:browse-source', 'nexus')
    let resolveSources!: (sources: SourceInfo[]) => void
    mocks.sources.mockReturnValue(
        new Promise<SourceInfo[]>((resolve) => {
            resolveSources = resolve
        })
    )
    await mount()
    expect(screen.getByRole('status').textContent).toBe('Loading mod sources...')
    expect(screen.queryByTestId('nexus')).toBeNull()
    expect(mocks.path).not.toHaveBeenCalled()
    expect(mocks.installed).not.toHaveBeenCalled()
    expect(localStorage.getItem('modrex:pd3:browse-source')).toBe('nexus')

    await act(async () => resolveSources([modworkshop, nexus]))
    expectActive('nexus')
    expect(screen.getByTestId('modworkshop').getAttribute('data-active')).toBe('false')
    await vi.waitFor(() => expect(mocks.startup).toHaveBeenCalledWith('ready'))
})

test('Nexus-only games choose their declared source on first use', async () => {
    mocks.sources.mockResolvedValue([nexus])
    await mount()
    await screen.findByTestId('nexus')
    expectActive('nexus')
    expect(screen.queryByTestId('modworkshop')).toBeNull()
})

test('a stale saved provider falls back to the first declared provider', async () => {
    localStorage.setItem('modrex:pd3:browse-source', 'modworkshop')
    mocks.sources.mockResolvedValue([nexus])
    await mount()
    await screen.findByTestId('nexus')
    expectActive('nexus')
    expect(screen.queryByTestId('modworkshop')).toBeNull()
})

test('the default follows registry order rather than a hardcoded provider', async () => {
    mocks.sources.mockResolvedValue([nexus, modworkshop])
    await mount()
    await screen.findByTestId('nexus')
    expectActive('nexus')
})

test('dual-provider games keep the normal default and save switches across restart', async () => {
    const first = await mount()
    await screen.findByTestId('modworkshop')
    expectActive('modworkshop')
    fireEvent.click(screen.getByRole('button', { name: 'Choose Nexus' }))
    expectActive('nexus')
    expect(localStorage.getItem('modrex:pd3:browse-source')).toBe('nexus')
    first.unmount()

    await mount()
    await screen.findByTestId('nexus')
    expectActive('nexus')
    fireEvent.click(screen.getByRole('button', { name: 'Choose ModWorkshop' }))
    expectActive('modworkshop')
    expect(localStorage.getItem('modrex:pd3:browse-source')).toBe('modworkshop')
})

test('providerless games open Installed without a blank Browse view', async () => {
    mocks.sources.mockResolvedValue([])
    await mount()
    await screen.findByTestId('installed')
    expectActive('installed')
    expect(screen.queryByTestId('nexus')).toBeNull()
    expect(screen.queryByTestId('modworkshop')).toBeNull()
    expect(
        within(screen.getByRole('complementary')).queryByRole('button', { name: 'Browse Mods' })
    ).toBeNull()
})

test('source initialization errors are visible and retry preserves the workspace choice', async () => {
    localStorage.setItem('modrex:pd3:browse-source', 'nexus')
    mocks.sources.mockRejectedValueOnce(new Error('Source registry unavailable'))
    const { unmount } = await mount()
    expect((await screen.findByRole('alert')).textContent).toContain(
        'Mod sources could not be loaded.'
    )
    expect(screen.getByRole('alert').textContent).toContain('Source registry unavailable')
    expect(mocks.path).not.toHaveBeenCalled()
    expect(mocks.startup).toHaveBeenCalledWith('error')
    expect(mocks.log).toHaveBeenCalledWith(
        'Mod source initialization failed: Error: Source registry unavailable'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('nexus')
    expectActive('nexus')
    expect(mocks.sources).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('modrex:scope')).toBe('game')
    expect(localStorage.getItem('modrex:pd3:browse-source')).toBe('nexus')
    unmount()
})

test('picker and global settings remain accessible while sources are loading', async () => {
    mocks.sources.mockReturnValue(new Promise<SourceInfo[]>(() => {}))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Change game' }))
    expect(screen.getByRole('heading', { name: 'Games' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Global settings' })).toBeTruthy()
    expect(mocks.path).not.toHaveBeenCalled()
    expect(mocks.installed).not.toHaveBeenCalled()
})

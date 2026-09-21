import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { FolderOpen, Loader } from 'lucide-react'
import { Button } from './ui/Button'
import { Select } from './Select'
import { Toggle } from './Toggle'
import { SkeletonBar } from './Skeleton'
import { SettingsSection as Section } from './SettingsSection'
import { api, type DetectedInstall, type GameSettings } from '../api'
import { getSettingsCache, setSettingsCache, patchSettingsCache } from '../settingsCache'
import { GAMES, type GameId } from '../../../shared/types'
import { t } from '../i18n'
import SteamIcon from '../../../../assets/icons/steam.svg?react'
import EpicIcon from '../../../../assets/icons/epicgames.svg?react'
import XboxIcon from '../../../../assets/icons/xbox.svg?react'

const iconClass = 'w-3.5 h-3.5 shrink-0 fill-current'

// Keyed by the launcher ids the Rust registry reports. Only the key is held here: t()
// at module scope would freeze at import time and never follow a language switch.
const LAUNCHER_LABELS: Record<string, { labelKey: Parameters<typeof t>[0]; icon?: ReactNode }> = {
    steam: { labelKey: 'settings.launcher.steam', icon: <SteamIcon className={iconClass} /> },
    epic: { labelKey: 'settings.launcher.epic', icon: <EpicIcon className={iconClass} /> },
    xbox: { labelKey: 'settings.launcher.xbox', icon: <XboxIcon className={iconClass} /> },
    manual: { labelKey: 'settings.launcher.manual' },
}

function SettingsSkeleton() {
    return (
        <div className="flex flex-col gap-6 animate-pulse" aria-hidden="true">
            {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                    <SkeletonBar className="h-3 w-32" />
                    <SkeletonBar className="h-2.5 w-2/3" />
                    <SkeletonBar className="h-11 w-full rounded-lg mt-1" />
                </div>
            ))}
        </div>
    )
}

// A copy being updated may be absent from detection. Keep its saved launcher.
function effectiveLauncher(gs: GameSettings, installs: DetectedInstall[]): string {
    return gs.launcher ?? installs[0]?.launcher ?? 'steam'
}

interface Props {
    activeGame: GameId
    gamePath: string | null
    gamePathReady: boolean
    onGamePathChange: () => Promise<void>
}

export function GameSettings({ activeGame, gamePath, gamePathReady, onGamePathChange }: Props) {
    const [settings, setSettings] = useState<GameSettings | null>(
        () => getSettingsCache(activeGame)?.settings ?? null
    )
    const [picking, setPicking] = useState(false)
    const [pathError, setPathError] = useState<string | null>(null)
    const [launcher, setLauncher] = useState(() => {
        const cached = getSettingsCache(activeGame)
        return cached ? effectiveLauncher(cached.settings, cached.installs) : 'steam'
    })
    const [installs, setInstalls] = useState<DetectedInstall[]>(
        () => getSettingsCache(activeGame)?.installs ?? []
    )
    const [installsReady, setInstallsReady] = useState(
        () => getSettingsCache(activeGame) !== undefined
    )
    const [launcherError, setLauncherError] = useState<string | null>(null)
    const [launchOptions, setLaunchOptions] = useState(
        () => getSettingsCache(activeGame)?.settings.launchOptions ?? ''
    )
    const requiredLaunchFlag = GAMES[activeGame].requiredLaunchFlag
    const pendingLaunchOptions = useRef<string | null>(null)
    const launchOptionsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const [launchOptionsError, setLaunchOptionsError] = useState<string | null>(null)
    const [crimeBossInstallMode, setCrimeBossInstallMode] = useState(
        () => getSettingsCache(activeGame)?.settings.crimebossInstallMode ?? 'auto'
    )
    const [suppressCrashReporter, setSuppressCrashReporter] = useState(
        () => getSettingsCache(activeGame)?.settings.suppressCrashReporter === true
    )
    // Store detection can take seconds. It must not delay displaying saved settings.
    useEffect(() => {
        let cancelled = false

        api.getGameSettings(activeGame).then((gs) => {
            if (cancelled) return
            setSettings(gs)
            setLaunchOptions(gs.launchOptions ?? '')
            setCrimeBossInstallMode(gs.crimebossInstallMode ?? 'auto')
            setSuppressCrashReporter(gs.suppressCrashReporter === true)
        })

        const cached = getSettingsCache(activeGame)
        setInstallsReady(cached !== undefined)
        const detected = cached
            ? Promise.resolve(cached.installs)
            : api.getDetectedInstalls(activeGame)
        detected.then((found) => {
            if (cancelled) return
            setInstalls(found)
            setInstallsReady(true)
        })

        return () => {
            cancelled = true
        }
    }, [activeGame])

    // Wait for both reads. The saved launcher and path identify the same game copy.
    useEffect(() => {
        if (!settings || !installsReady) return
        setSettingsCache(activeGame, { settings, installs })
        setLauncher(effectiveLauncher(settings, installs))
    }, [settings, installs, installsReady, activeGame])

    const saveLaunchOptions = useCallback(() => {
        const value = pendingLaunchOptions.current
        if (value === null) return
        pendingLaunchOptions.current = null
        void api
            .setLaunchOptions(value, activeGame)
            .then(() => patchSettingsCache(activeGame, { launchOptions: value }))
            .catch((error) => {
                setLaunchOptionsError(String(error))
                void logError('Saving launch options failed: ' + String(error))
            })
    }, [activeGame])

    useEffect(
        () => () => {
            clearTimeout(launchOptionsTimer.current)
            saveLaunchOptions()
        },
        [saveLaunchOptions]
    )

    function handleLaunchOptionsChange(value: string) {
        setLaunchOptions(value)
        setLaunchOptionsError(null)
        pendingLaunchOptions.current = value
        clearTimeout(launchOptionsTimer.current)
        launchOptionsTimer.current = setTimeout(saveLaunchOptions, 500)
    }

    // Keep the saved copy selectable even while detection cannot find it.
    const launcherOptions = useMemo(() => {
        const ids = installs.map((install) => install.launcher)
        if (!ids.includes(launcher)) ids.push(launcher)
        return ids.map((id) => {
            const spec = LAUNCHER_LABELS[id]
            return { value: id, label: spec ? t(spec.labelKey) : id, icon: spec?.icon }
        })
    }, [installs, launcher])

    async function handleBrowse() {
        setPicking(true)
        setPathError(null)
        try {
            const picked = await api.pickFolder(
                t('settings.gamePath.pickTitle', { game: GAMES[activeGame].name })
            )
            if (!picked) return
            try {
                await api.setGamePath(picked, activeGame)
                // Read back rather than assume: the backend also identifies which store
                // the picked folder belongs to, and the launcher shown has to be that
                // one, not whichever was selected for the copy being replaced.
                const saved = await api.getGameSettings(activeGame)
                setSettings(saved)
                patchSettingsCache(activeGame, {
                    gamePath: saved.gamePath,
                    launcher: saved.launcher,
                })
                await onGamePathChange()
            } catch {
                setPathError(t('settings.gamePath.invalid', { game: GAMES[activeGame].name }))
            }
        } finally {
            setPicking(false)
        }
    }

    // Launcher changes must select that store's path as well as its launcher.
    async function handleLauncherChange(value: string) {
        // The only option without a detected copy behind it is the one already selected,
        // so re-selecting it is the one no-op this can be called with.
        const install = installs.find((i) => i.launcher === value)
        if (!install) return
        const previous = launcher
        setLauncher(value)
        setLauncherError(null)
        try {
            await api.selectGameInstall(activeGame, value, install.gamePath)
        } catch {
            setLauncher(previous)
            setLauncherError(t('settings.launcher.switchFailed'))
            return
        }
        patchSettingsCache(activeGame, { launcher: value, gamePath: install.gamePath })
        setSettings((s) => ({ ...s, launcher: value, gamePath: install.gamePath }))
        await onGamePathChange()
    }

    async function handleCrimeBossInstallModeChange(value: string) {
        setCrimeBossInstallMode(value)
        patchSettingsCache(activeGame, { crimebossInstallMode: value })
        await api.setCrimeBossInstallMode(value)
    }

    async function handleSuppressCrashReporterChange(value: boolean) {
        setSuppressCrashReporter(value)
        patchSettingsCache(activeGame, { suppressCrashReporter: value })
        await api.setSuppressCrashReporter(value, activeGame)
    }

    if (settings === null) return <SettingsSkeleton />

    return (
        <>
            <Section
                title={t('settings.gamePath.title')}
                description={t('settings.gamePath.description', {
                    game: GAMES[activeGame].name,
                })}
            >
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-hover border border-border mt-1">
                    {!gamePathReady ? (
                        <span className="text-sm flex-1 text-text-muted flex items-center gap-2">
                            <Loader className="w-3.5 h-3.5 animate-spin shrink-0" />
                            {t('settings.gamePath.detecting')}
                        </span>
                    ) : (
                        <span className="text-sm font-mono truncate flex-1 text-text-muted">
                            {gamePath ?? t('settings.gamePath.notFound')}
                        </span>
                    )}
                    <div className="flex gap-2 shrink-0">
                        <Button
                            variant="accent"
                            size="md"
                            disabled={picking}
                            onClick={handleBrowse}
                        >
                            <FolderOpen className="w-3.5 h-3.5" />
                            {picking
                                ? t('settings.gamePath.picking')
                                : t('settings.gamePath.browse')}
                        </Button>
                    </div>
                </div>
                {pathError ? (
                    <p className="text-xs text-danger-text">{pathError}</p>
                ) : !gamePathReady ? null : gamePath ? (
                    <p className="text-xs text-success-text">
                        {t('settings.gamePath.autoDetected')}
                    </p>
                ) : (
                    <p className="text-xs text-danger-text">
                        {t('settings.gamePath.notDetected', {
                            game: GAMES[activeGame].name,
                        })}
                    </p>
                )}
            </Section>

            <Section
                title={t('settings.launcher.title')}
                description={t('settings.launcher.description', {
                    game: GAMES[activeGame].name,
                })}
            >
                <div className="mt-1">
                    {!installsReady ? (
                        <span className="text-sm text-text-muted flex items-center gap-2">
                            <Loader className="w-3.5 h-3.5 animate-spin shrink-0" />
                            {t('settings.launcher.detecting')}
                        </span>
                    ) : (
                        <Select
                            value={launcher}
                            onChange={handleLauncherChange}
                            options={launcherOptions}
                            disabled={launcherOptions.length <= 1}
                        />
                    )}
                </div>
                {launcherError ? (
                    <p className="text-xs text-danger-text">{launcherError}</p>
                ) : installs.length > 1 ? (
                    <p className="text-xs text-text-subtle">
                        {t('settings.launcher.multipleCopies', {
                            count: installs.length,
                        })}
                    </p>
                ) : null}
            </Section>

            {activeGame === 'cb' && (
                <Section
                    title={t('settings.crimeBossInstallMode.title')}
                    description={t('settings.crimeBossInstallMode.description')}
                >
                    <div className="mt-1">
                        <Select
                            value={crimeBossInstallMode}
                            onChange={handleCrimeBossInstallModeChange}
                            options={[
                                {
                                    value: 'auto',
                                    label: t('settings.crimeBossInstallMode.auto'),
                                },
                                {
                                    value: 'ask',
                                    label: t('settings.crimeBossInstallMode.ask'),
                                },
                            ]}
                        />
                    </div>
                </Section>
            )}

            {activeGame === 'pd3' && launcher === 'xbox' && (
                <Section title={t('settings.crashReporter.title')}>
                    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border mt-1">
                        <span className="text-sm text-text-muted pr-4">
                            {t('settings.crashReporter.description')}
                        </span>
                        <Toggle
                            checked={suppressCrashReporter}
                            onChange={handleSuppressCrashReporterChange}
                            title={t('settings.crashReporter.title')}
                        />
                    </div>
                </Section>
            )}

            <Section title={t('settings.launchOptions.title')}>
                {launchOptionsError && (
                    <p role="alert" className="text-xs text-danger-text">
                        {launchOptionsError}
                    </p>
                )}
                {(launcher === 'xbox' || requiredLaunchFlag) && (
                    <p className="text-xs text-text-subtle">
                        {launcher === 'xbox'
                            ? t('settings.launchOptions.xboxNote')
                            : t('settings.launchOptions.description', {
                                  flag: requiredLaunchFlag!,
                              })}
                    </p>
                )}
                <input
                    type="text"
                    aria-label={t('settings.launchOptions.title')}
                    value={launchOptions}
                    onChange={(e) => handleLaunchOptionsChange(e.target.value)}
                    placeholder={requiredLaunchFlag ?? ''}
                    disabled={launcher === 'xbox'}
                    className="text-sm font-mono px-3 py-2 rounded-lg bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed mt-1"
                />
            </Section>
        </>
    )
}

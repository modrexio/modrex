import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { SettingsSection as Section } from './SettingsSection'
import { BetaBadge } from './BetaBadge'
import { TITLE_ROW_MIN_H } from './pageHeader'
import { Button } from './ui/Button'
import {
    FolderOpen,
    RefreshCw,
    ScrollText,
    Gamepad2,
    AppWindow,
    Wrench,
    Heart,
    Globe,
    Info,
    TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { siGithub, siDiscord, siX, siBluesky } from 'simple-icons'
import { t, getLocale, setLocale } from '../i18n'
import { LOCALE_IDS, localeLabel, type LocaleId } from '../locales'
import { ACCENT_COLORS, setAccentColor, useAccentColor, type AccentColor } from '../accentColor'
import { Select } from './Select'
import { Dialog, DialogHeader } from './Dialog'
import { Toggle } from './Toggle'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { StorageSettings } from './StorageSettings'
import { SisrSettings } from './SisrSettings'
import { api } from '../api'

const iconClass = 'w-3.5 h-3.5 shrink-0 fill-current'

const APP_VERSION = import.meta.env.DEV ? 'v-dev' : `v${import.meta.env.VITE_APP_VERSION}`

const GITHUB_URL = 'https://github.com/modrexio/modrex'
const SPONSOR_URL = 'https://github.com/sponsors/modrexio'
const DISCORD_URL = 'https://discord.gg/QM2rDgy43Y'
const X_URL = 'https://x.com/modrexio'
const BLUESKY_URL = 'https://bsky.app/profile/modrex.net'
const WEBSITE_URL = 'https://modrex.net/'

type SettingsTab = 'game' | 'application' | 'advanced' | 'about'

const GAME_TAB_KEY = 'modrex:settings-tab'
const GLOBAL_TAB_KEY = 'modrex:settings-tab:global'

// For navigation into a specific tab from outside the page: the page re-reads
// the saved tab on every activation, so writing before switching views lands there.
export function saveSettingsTab(tab: SettingsTab) {
    localStorage.setItem(GAME_TAB_KEY, tab)
}

function readSavedTab(hasGameSettings: boolean): SettingsTab {
    const saved = localStorage.getItem(hasGameSettings ? GAME_TAB_KEY : GLOBAL_TAB_KEY)
    if (!hasGameSettings) {
        return saved === 'application' || saved === 'advanced' || saved === 'about'
            ? saved
            : 'application'
    }
    return saved === 'game' || saved === 'application' || saved === 'advanced' || saved === 'about'
        ? saved
        : 'game'
}

export interface AppSettingsProps {
    isActive: boolean
    analyticsConsent: boolean | null
    onAnalyticsConsent: (enabled: boolean) => void
    discordPresenceEnabled: boolean
    onDiscordPresenceEnabled: (enabled: boolean) => void
}

export function SettingsPage({
    isActive,
    analyticsConsent,
    onAnalyticsConsent,
    discordPresenceEnabled,
    onDiscordPresenceEnabled,
    game,
}: AppSettingsProps & { game?: { name: string; content: ReactNode; folders: ReactNode } }) {
    const [checkState, setCheckState] = useState<'idle' | 'checking' | 'upToDate'>('idle')
    const hasGameSettings = game !== undefined
    const [showAnalyticsDetails, setShowAnalyticsDetails] = useState(false)
    const [activeTab, setActiveTabState] = useState<SettingsTab>(() =>
        readSavedTab(hasGameSettings)
    )
    const [nexusSignedIn, setNexusSignedIn] = useState<boolean | null>(null)
    // Signed out because the session lapsed rather than because the user asked, which
    // needs saying: the sign-in button alone gives no hint that anything was lost.
    const [nexusSessionExpired, setNexusSessionExpired] = useState(false)
    const [nexusSignInError, setNexusSignInError] = useState<string | null>(null)
    const [secretStoreAvailable, setSecretStoreAvailable] = useState<boolean | null>(null)
    const [confirmNexusSignOut, setConfirmNexusSignOut] = useState(false)
    const accentColor = useAccentColor()
    const accentColorOptions = useMemo(
        () =>
            (Object.keys(ACCENT_COLORS) as AccentColor[]).map((color) => ({
                value: color,
                label: t(`settings.accentColor.${color}`),
                icon: (
                    <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: ACCENT_COLORS[color].swatch }}
                    />
                ),
            })),
        []
    )

    const languageOptions = useMemo(
        () => LOCALE_IDS.map((id) => ({ value: id, label: localeLabel(id) })),
        []
    )

    const navItems: { id: SettingsTab; label: string; icon: LucideIcon }[] = useMemo(
        () => [
            { id: 'game', label: t('settings.nav.game'), icon: Gamepad2 },
            { id: 'application', label: t('settings.nav.application'), icon: AppWindow },
            { id: 'advanced', label: t('settings.nav.advanced'), icon: Wrench },
            { id: 'about', label: t('settings.nav.about'), icon: Info },
        ],
        []
    )

    // Re-read on activation, not just mount: the page stays mounted as a hidden
    // pane, and other pages can request a tab via saveSettingsTab before navigating.
    useEffect(() => {
        if (isActive) setActiveTabState(readSavedTab(hasGameSettings))
    }, [isActive, hasGameSettings])

    function setActiveTab(tab: SettingsTab) {
        setActiveTabState(tab)
        localStorage.setItem(hasGameSettings ? GAME_TAB_KEY : GLOBAL_TAB_KEY, tab)
    }

    useEffect(() => {
        let cancelled = false
        api.isNexusSignedIn().then((signedIn) => {
            if (!cancelled) setNexusSignedIn(signedIn)
        })
        // Not tied to sign-in state: this reflects a static OS fact, checked once
        // per session, so the warning below is accurate even for an existing session.
        api.secretStoreAvailable().then((available) => {
            if (!cancelled) setSecretStoreAvailable(available)
        })
        const offSignedIn = api.onNexusOAuthSignedIn(() => {
            setNexusSignedIn(true)
            setNexusSignInError(null)
            setNexusSessionExpired(false)
        })
        const offFailed = api.onNexusOAuthFailed((error) => setNexusSignInError(error))
        // The backend already cleared the stored sign-in, so this section has to follow it
        // down rather than keep offering a Sign out button for credentials that are gone.
        const offExpired = api.onNexusSessionExpired(() => {
            setNexusSignedIn(false)
            setNexusSignInError(null)
            setNexusSessionExpired(true)
        })
        return () => {
            cancelled = true
            offSignedIn()
            offFailed()
            offExpired()
        }
    }, [])

    async function handleCheckForUpdates() {
        setCheckState('checking')
        try {
            await api.checkForUpdates()
            setCheckState('upToDate')
            setTimeout(() => setCheckState('idle'), 3000)
        } catch {
            setCheckState('idle')
        }
    }

    function handleNexusSignIn() {
        setNexusSignInError(null)
        api.nexusOAuthStart()
    }

    async function handleNexusSignOut() {
        setConfirmNexusSignOut(false)
        await api.nexusSignOut()
        setNexusSignedIn(false)
    }

    const visibleTabs = game ? navItems : navItems.filter((item) => item.id !== 'game')

    return (
        <div className="h-full flex flex-col">
            <div className="px-6 py-4 border-b border-border shrink-0">
                <div className={`flex flex-col justify-center ${TITLE_ROW_MIN_H}`}>
                    <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
                    {game && <p className="text-xs text-text-subtle mt-0.5">{game.name}</p>}
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
                <nav className="w-44 border-r border-border shrink-0 flex flex-col gap-1 p-2">
                    {visibleTabs.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setActiveTab(id)}
                            className={`w-full px-2 py-2 gap-2.5 flex items-center rounded text-sm transition-colors ${
                                activeTab === id
                                    ? 'bg-surface-active text-text'
                                    : 'text-text-muted hover:bg-surface-hover hover:text-text'
                            }`}
                        >
                            <Icon className="w-4 h-4 shrink-0" />
                            <span className="truncate">{label}</span>
                        </button>
                    ))}
                </nav>

                <div className="flex-1 overflow-y-auto px-6 py-6">
                    <div className="max-w-xl flex flex-col gap-6">
                        {activeTab === 'game' && game?.content}
                        {activeTab === 'application' && (
                            <>
                                <Section
                                    title={t('settings.language.title')}
                                    description={t('settings.language.description')}
                                >
                                    <div className="mt-1">
                                        <Select
                                            value={getLocale()}
                                            onChange={(value) => setLocale(value as LocaleId)}
                                            options={languageOptions}
                                            icon={<Globe className="w-3.5 h-3.5" />}
                                        />
                                    </div>
                                </Section>

                                <Section
                                    title={t('settings.accentColor.title')}
                                    description={t('settings.accentColor.description')}
                                >
                                    <div className="mt-1">
                                        <Select
                                            value={accentColor}
                                            onChange={(value) =>
                                                setAccentColor(value as AccentColor)
                                            }
                                            options={accentColorOptions}
                                        />
                                    </div>
                                </Section>

                                <Section title={t('settings.updates.title')}>
                                    <div className="flex items-center gap-3 mt-1">
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            disabled={checkState === 'checking'}
                                            onClick={handleCheckForUpdates}
                                        >
                                            <RefreshCw
                                                className={`w-3.5 h-3.5 ${checkState === 'checking' ? 'animate-spin' : ''}`}
                                            />
                                            {checkState === 'checking'
                                                ? t('settings.updates.checking')
                                                : t('settings.updates.check')}
                                        </Button>
                                        {checkState === 'upToDate' && (
                                            <span className="text-xs text-success-text">
                                                {t('settings.updates.upToDate')}
                                            </span>
                                        )}
                                    </div>
                                </Section>

                                <Section title={t('telemetry.settingsTitle')}>
                                    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border mt-1">
                                        <span className="text-sm text-text-muted pr-4">
                                            {t('telemetry.settingsDescription')}
                                        </span>
                                        <Toggle
                                            checked={analyticsConsent === true}
                                            onChange={onAnalyticsConsent}
                                        />
                                    </div>
                                    <button
                                        onClick={() => setShowAnalyticsDetails(true)}
                                        className="text-xs text-accent hover:underline self-start"
                                    >
                                        {t('telemetry.detailsToggle')}
                                    </button>
                                </Section>

                                <Section title={t('telemetry.discordPresenceTitle')}>
                                    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border mt-1">
                                        <span className="text-sm text-text-muted pr-4">
                                            {t('telemetry.discordPresenceDescription')}
                                        </span>
                                        <Toggle
                                            checked={discordPresenceEnabled}
                                            onChange={onDiscordPresenceEnabled}
                                        />
                                    </div>
                                </Section>
                            </>
                        )}

                        {activeTab === 'about' && (
                            <>
                                <div className="flex flex-col items-center gap-1 py-6 text-center">
                                    <span
                                        style={{
                                            fontFamily: "'Bebas Neue', sans-serif",
                                            fontSize: '3rem',
                                            letterSpacing: '0.05em',
                                            lineHeight: 1,
                                        }}
                                    >
                                        <span style={{ color: 'var(--color-text)' }}>MOD</span>
                                        <span style={{ color: 'var(--color-accent)' }}>REX</span>
                                    </span>
                                    <span className="text-xs text-text-subtle">{APP_VERSION}</span>
                                    <p className="text-sm text-text-muted mt-2">
                                        {t('settings.about.tagline')}
                                    </p>
                                </div>

                                <Section title={t('settings.about.supportTitle')}>
                                    <div className="flex flex-col gap-3 px-4 py-3 rounded-lg border border-border bg-surface-raised mt-1">
                                        <p className="text-sm text-text-muted">
                                            {t('settings.about.supportBody')}
                                        </p>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button
                                                variant="accent"
                                                size="md"
                                                onClick={() => api.openExternal(SPONSOR_URL)}
                                            >
                                                <Heart className="w-3.5 h-3.5 shrink-0" />
                                                {t('settings.about.sponsor')}
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="md"
                                                onClick={() => api.openExternal(GITHUB_URL)}
                                            >
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    className={iconClass}
                                                    aria-hidden
                                                >
                                                    <path d={siGithub.path} />
                                                </svg>
                                                {t('settings.about.star')}
                                            </Button>
                                        </div>
                                    </div>
                                </Section>

                                <Section title={t('settings.about.communityTitle')}>
                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openExternal(DISCORD_URL)}
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                className={iconClass}
                                                aria-hidden
                                            >
                                                <path d={siDiscord.path} />
                                            </svg>
                                            {t('settings.about.discord')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openExternal(X_URL)}
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                className={iconClass}
                                                aria-hidden
                                            >
                                                <path d={siX.path} />
                                            </svg>
                                            {t('settings.about.x')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openExternal(BLUESKY_URL)}
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                className={iconClass}
                                                aria-hidden
                                            >
                                                <path d={siBluesky.path} />
                                            </svg>
                                            {t('settings.about.bluesky')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openExternal(WEBSITE_URL)}
                                        >
                                            <Globe className="w-3.5 h-3.5 shrink-0" />
                                            {t('settings.about.website')}
                                        </Button>
                                    </div>
                                </Section>

                                <p className="text-xs text-text-subtle">
                                    {t('settings.about.disclaimer')}
                                </p>
                            </>
                        )}

                        {activeTab === 'advanced' && (
                            <>
                                <SisrSettings isActive={isActive} />

                                <Section
                                    title={t('settings.logs.title')}
                                    description={t('settings.logs.description')}
                                >
                                    <div className="mt-1">
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openLog()}
                                        >
                                            <ScrollText className="w-3.5 h-3.5" />
                                            {t('settings.logs.open')}
                                        </Button>
                                    </div>
                                </Section>

                                <Section
                                    title={t('settings.nexusAccount.title')}
                                    badge={<BetaBadge />}
                                    description={t('settings.nexusAccount.description')}
                                >
                                    <div className="flex items-center gap-3 mt-1">
                                        {nexusSignedIn === true ? (
                                            <>
                                                <span className="text-xs text-success-text">
                                                    {t('settings.nexusAccount.signedIn')}
                                                </span>
                                                <Button
                                                    variant="secondary"
                                                    size="md"
                                                    onClick={() => setConfirmNexusSignOut(true)}
                                                >
                                                    {t('settings.nexusAccount.signOut')}
                                                </Button>
                                            </>
                                        ) : (
                                            <Button
                                                variant="accent"
                                                size="md"
                                                onClick={handleNexusSignIn}
                                            >
                                                {t('settings.nexusAccount.signIn')}
                                            </Button>
                                        )}
                                    </div>
                                    {nexusSessionExpired && (
                                        <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning">
                                            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                            <span>{t('settings.nexusAccount.sessionExpired')}</span>
                                        </div>
                                    )}
                                    {nexusSignInError !== null && (
                                        <p className="text-xs text-danger-text">
                                            {t('settings.nexusAccount.failed', {
                                                error: nexusSignInError,
                                            })}
                                        </p>
                                    )}
                                    {nexusSignedIn === true && secretStoreAvailable === false && (
                                        <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning">
                                            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                            <span>
                                                {t('settings.nexusAccount.insecureStorage')}
                                            </span>
                                        </div>
                                    )}
                                    <Dialog
                                        open={confirmNexusSignOut}
                                        onOpenChange={(open) =>
                                            !open && setConfirmNexusSignOut(false)
                                        }
                                        title={t('settings.nexusAccount.signOutConfirmTitle')}
                                        className="w-80"
                                    >
                                        <DialogHeader
                                            title={t('settings.nexusAccount.signOutConfirmTitle')}
                                            subtitle={t('settings.nexusAccount.signOutConfirmBody')}
                                            onClose={() => setConfirmNexusSignOut(false)}
                                            wrapSubtitle
                                        />
                                        <div className="flex items-center justify-end gap-2 px-5 py-4 shrink-0">
                                            <Button
                                                variant="secondary"
                                                size="md"
                                                onClick={() => setConfirmNexusSignOut(false)}
                                            >
                                                {t('common.cancel')}
                                            </Button>
                                            <Button
                                                variant="accent"
                                                size="md"
                                                onClick={handleNexusSignOut}
                                            >
                                                {t('settings.nexusAccount.signOutConfirm')}
                                            </Button>
                                        </div>
                                    </Dialog>
                                </Section>
                                <Section
                                    title={t('settings.folders.title')}
                                    description={t('settings.folders.description')}
                                >
                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                        {game?.folders}
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openDataFolder()}
                                        >
                                            <FolderOpen className="w-3.5 h-3.5" />
                                            {t('settings.folders.dataFolder')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => api.openAppFolder()}
                                        >
                                            <FolderOpen className="w-3.5 h-3.5" />
                                            {t('settings.folders.appFolder')}
                                        </Button>
                                    </div>
                                </Section>

                                <StorageSettings />
                            </>
                        )}
                    </div>
                </div>
            </div>

            <TelemetryConsentDialog
                open={showAnalyticsDetails}
                dismissable
                onClose={() => setShowAnalyticsDetails(false)}
                onChoice={(enabled) => {
                    onAnalyticsConsent(enabled)
                    setShowAnalyticsDetails(false)
                }}
            />
        </div>
    )
}

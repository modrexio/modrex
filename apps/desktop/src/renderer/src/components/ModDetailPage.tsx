import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { Button } from './ui/Button'
import * as Tabs from '@radix-ui/react-tabs'
import {
    ArrowLeft,
    Trash2,
    Download,
    ExternalLink,
    ChevronLeft,
    ChevronRight,
    Heart,
    X,
    AlertTriangle,
    Tag as TagIcon,
    Image as ImageIcon,
    CalendarDays,
    Clock,
    Users,
    Link as LinkIcon,
} from 'lucide-react'
import { siGit, siGithub, siGitlab, siBitbucket, type SimpleIcon } from 'simple-icons'
import { t } from '../i18n'
import { Toggle } from './Toggle'
import { Tooltip } from './Tooltip'
import type {
    GameId,
    Mod,
    ModFile,
    ModLink,
    ModDependency,
    InstalledMod,
    ModSummary,
} from '../../../shared/types'
import { AVATAR_BASE_URL } from '../../../shared/types'
import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'
import {
    getCachedMod,
    getCachedModFiles,
    getCachedModLinks,
    getModCacheEntry,
    getFilesCacheEntry,
    getLinksCacheEntry,
} from '../modCache'
import {
    getCachedNexusMod,
    getNexusModCacheEntry,
    getCachedNexusModFiles,
    getNexusFilesCacheEntry,
} from '../nexusModCache'
import { nativeIdFor } from '../sources'
import { NexusDescription } from './NexusDescription'
import { DepsWarningModal } from './DepsWarningModal'
import { FileSelectModal } from './FileSelectModal'
import { NonPakConfirmModal } from './NonPakConfirmModal'
import { ZipPickerModal } from './ZipPickerModal'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { HostPackModal } from './HostPackModal'
import type { HostPackPayload } from './HostPackModal'
import { UnrecognizedArchiveModal } from './UnrecognizedArchiveModal'
import { CrimeBossFlatArchiveModal } from './CrimeBossFlatArchiveModal'
import type { CbFlatArchivePayload } from './CrimeBossFlatArchiveModal'
import { CrimeBossInstallTargetModal } from './CrimeBossInstallTargetModal'
import { useCrimeBossInstallTarget } from '../hooks/useCrimeBossInstallTarget'
import { isUnsupportedFormat } from '../formatCheck'
import { handleInstallOutcome } from '../installSentinels'
import { collectDeps, isLoaderDep, missingRequiredDeps } from '../deps'
import { loaderForModId, loadersForGame } from '../loaders'
import { useLoaderState } from '../hooks/useLoaderState'
import { resolveDepCheck } from '../installDepCheck'
import { useThumbnail } from '../hooks/useThumbnail'
import { api } from '../api'
import { attemptAll, describeFailures } from '../bulkAction'
import { markForegroundActivity } from '../requestPriority'
import { DescriptionTab, ChangelogTab, LicenseTab } from './modDetail/textTabs'
import { LightboxImage, ImagesTab } from './modDetail/ImagesTab'
import { DownloadsTab } from './modDetail/DownloadsTab'
import { DepsTab } from './modDetail/DepsTab'
import { formatDate } from './modDetail/format'
import { SkeletonBar } from './Skeleton'

type Tab = 'description' | 'images' | 'downloads' | 'changelog' | 'license' | 'deps'

function ModDetailSkeleton() {
    return (
        <div className="flex-1 overflow-hidden animate-pulse" aria-hidden="true">
            <SkeletonBar className="w-full aspect-[4/1] max-h-72 rounded-none" />
            <div className="flex items-start gap-6 px-6">
                <div className="min-w-0 flex-1">
                    <div className="py-5 border-b border-border">
                        <SkeletonBar className="h-5 w-1/2" />
                    </div>
                    <div className="flex gap-6 py-3 border-b border-border">
                        <SkeletonBar className="h-2.5 w-16" />
                        <SkeletonBar className="h-2.5 w-14" />
                        <SkeletonBar className="h-2.5 w-20" />
                    </div>
                    <div className="py-5 flex flex-col gap-2">
                        <SkeletonBar className="h-2.5 w-full" />
                        <SkeletonBar className="h-2.5 w-5/6" />
                        <SkeletonBar className="h-2.5 w-2/3" />
                    </div>
                </div>
                <div className="w-1/3 min-w-64 max-w-md my-5 rounded-lg bg-surface-raised border border-border p-4 flex flex-col gap-4">
                    <div className="grid grid-cols-3 gap-4">
                        <SkeletonBar className="h-8" />
                        <SkeletonBar className="h-8" />
                        <SkeletonBar className="h-8" />
                    </div>
                    <SkeletonBar className="h-2.5 w-3/4" />
                    <SkeletonBar className="h-2.5 w-1/2" />
                    <div className="flex gap-1.5">
                        <SkeletonBar className="h-5 w-16 rounded-full" />
                        <SkeletonBar className="h-5 w-20 rounded-full" />
                    </div>
                </div>
            </div>
        </div>
    )
}

// The member roles shown in the header credits line, mirroring modworkshop's
// mod page (its right pane lists collaborator/maintainer/contributor; viewers
// and unaccepted invites are hidden).
const CREDIT_LEVELS = new Set(['collaborator', 'maintainer', 'contributor'])

// Donation fields are free-form on the site, so they are only usable as http(s) links.
function httpUrl(raw: string | null | undefined): string | null {
    return raw && /^https?:\/\//.test(raw) ? raw : null
}

// modworkshop's donation values are not always URLs. A bare PayPal email or a
// paypal.me handle without a scheme are valid on the site. Same provider patterns
// as the site's donation-button component, so the button can say where it leads.
// Order matters: the hosted-button form must match before the generic paypal ones,
// and the bare-email PayPal form goes last as the loosest pattern.
const DONATION_PROVIDERS: [RegExp, string, (m: RegExpMatchArray) => string][] = [
    [
        /(?:https:\/\/)?(?:www\.)?paypal(?:\.me|\.com)\/donate\/\?hosted_button_id=(\w+)/,
        'PayPal',
        (m) => `https://www.paypal.com/donate/?hosted_button_id=${m[1]}`,
    ],
    [/(?:https:\/\/)?(?:www\.)?paypal\.me\/(\w+)/, 'PayPal', (m) => `https://paypal.me/${m[1]}`],
    [
        /(?:https:\/\/)?(?:www\.)?github\.com\/sponsors\/([\w-]+)/,
        'GitHub Sponsors',
        (m) => `https://github.com/sponsors/${m[1]}`,
    ],
    [/(?:https:\/\/)?(?:www\.)?ko-fi\.com\/(\w+)/, 'Ko-fi', (m) => `https://ko-fi.com/${m[1]}`],
    [
        /(?:https:\/\/)?(?:www\.)?buymeacoffee\.com\/(\w+)/,
        'Buy Me a Coffee',
        (m) => `https://buymeacoffee.com/${m[1]}`,
    ],
    [/(?:https:\/\/)?(?:www\.)?boosty\.to\/(\w+)/, 'Boosty', (m) => `https://boosty.to/${m[1]}`],
    [
        /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/,
        'PayPal',
        (m) => `https://www.paypal.com/donate/?business=${encodeURIComponent(m[0])}`,
    ],
]

function donationInfo(raw: string | null | undefined): { url: string; label: string } | null {
    if (!raw) return null
    for (const [pattern, label, toUrl] of DONATION_PROVIDERS) {
        const m = raw.match(pattern)
        if (m) return { url: toUrl(m), label }
    }
    const url = httpUrl(raw)
    if (!url) return null
    try {
        return { url, label: new URL(url).hostname.replace(/^www\./, '') }
    } catch {
        return null
    }
}

const REPO_HOST_ICONS: Record<string, SimpleIcon> = {
    'github.com': siGithub,
    'gitlab.com': siGitlab,
    'bitbucket.org': siBitbucket,
}

function repoHostIcon(url: string): SimpleIcon | null {
    try {
        return REPO_HOST_ICONS[new URL(url).hostname.replace(/^www\./, '')] ?? null
    } catch {
        return null
    }
}

function BrandIcon({ icon }: { icon: SimpleIcon }) {
    return (
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0 fill-current" aria-hidden>
            <path d={icon.path} />
        </svg>
    )
}

function creditLevelLabel(level: string): string {
    switch (level) {
        case 'collaborator':
            return t('detail.creditsLevelCollaborator')
        case 'maintainer':
            return t('detail.creditsLevelMaintainer')
        case 'contributor':
            return t('detail.creditsLevelContributor')
        default:
            return level
    }
}

interface Props {
    modId: number
    initialMod?: ModSummary
    // 'nexus' when this detail page was opened from the Nexus browse source. Absent
    // means modworkshop. Nexus mod ids are only unique within a game and can collide
    // numerically with a modworkshop id, so every cache lookup and installed-mod match
    // below branches on this rather than assuming modworkshop.
    source?: 'nexus'
    isActive?: boolean
    gamePath: string | null
    installed: InstalledMod[]
    activeGame?: GameId
    onBack: () => void
    onRefreshInstalled: () => Promise<void>
    onOpenDetail?: (modId: number) => void
}

export function ModDetailPage({
    modId,
    initialMod,
    source,
    isActive = true,
    gamePath,
    installed,
    activeGame = 'pd3',
    onBack,
    onRefreshInstalled,
    onOpenDetail,
}: Props) {
    const isNexus = source === 'nexus'
    const nexusDomain = isNexus ? nativeIdFor(activeGame, 'nexus') : null

    // Seed order: full cached entry > initialMod from browse list > null (shows spinner).
    // The browse list can only seed a SUMMARY, so the loaded detail is tracked separately
    // and mod is whichever is available for the header. Detail-only fields must read from
    // detail, which is what stops a half-loaded page claiming it has images or tags.
    const [detail, setDetail] = useState<Mod | null>(
        () =>
            (isNexus ? getNexusModCacheEntry(activeGame, modId) : getModCacheEntry(modId))?.mod ??
            null
    )
    const mod: ModSummary | null = detail ?? initialMod ?? null
    const [files, setFiles] = useState<ModFile[]>(
        () =>
            (isNexus
                ? getNexusFilesCacheEntry(activeGame, modId)?.files
                : getFilesCacheEntry(modId)?.files) ?? []
    )
    const [links, setLinks] = useState<ModLink[]>(() => getLinksCacheEntry(modId)?.links ?? [])
    // Skip full-page spinner when any mod data is available; skip files spinner when files are cached.
    const [loading, setLoading] = useState(
        () =>
            !(isNexus ? getNexusModCacheEntry(activeGame, modId) : getModCacheEntry(modId)) &&
            !initialMod
    )
    const [detailsLoading, setDetailsLoading] = useState(
        () =>
            !(isNexus ? getNexusModCacheEntry(activeGame, modId) : getModCacheEntry(modId)) &&
            initialMod !== undefined
    )
    // Nexus has no links concept, only files, so this spinner covers just the files
    // fetch for a Nexus mod (links stays permanently empty there).
    const [filesLoading, setFilesLoading] = useState(
        () => !(isNexus ? getNexusFilesCacheEntry(activeGame, modId) : getFilesCacheEntry(modId))
    )
    const [error, setError] = useState<string | null>(null)
    const [actionLoading, setActionLoading] = useState(false)
    const [installError, setInstallError] = useState<string | null>(null)
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
    const [showDepsWarning, setShowDepsWarning] = useState(false)
    // Presence state per loader id, from the registry. SuperBLT keys off 'superblt'
    // like the rest even though it has no modworkshop page.
    const { loaderState, setLoaderState, setLoaderFlag, installLoader, loaderModIds } =
        useLoaderState(activeGame, gamePath)
    const [showFileSelect, setShowFileSelect] = useState(false)
    const [showHeaderFormatWarning, setShowHeaderFormatWarning] = useState(false)
    const [zipPickerData, setZipPickerData] = useState<ZipMultiPakPayload | null>(null)
    const [hostPackData, setHostPackData] = useState<HostPackPayload | null>(null)
    const [unrecognizedModId, setUnrecognizedModId] = useState<number | null>(null)
    const [cbFlatArchiveData, setCbFlatArchiveData] = useState<CbFlatArchivePayload | null>(null)
    const crimeBossInstallTarget = useCrimeBossInstallTarget(
        activeGame,
        gamePath,
        onRefreshInstalled
    )
    const [downloadMap, setDownloadMap] = useState<
        ReadonlyMap<string, { downloaded: number; total: number }>
    >(new Map())

    // InstalledMod.id is an opaque local key regardless of source (see
    // sources::source_native_local_id), whereas modId here is always a real id (Nexus or
    // modworkshop), so both branches match against remoteId, never id.
    const installedFiles = isNexus
        ? installed.filter((m) => m.source === 'nexus' && m.remoteId === String(modId))
        : installed.filter(
              (m) => (!m.source || m.source === 'modworkshop') && m.remoteId === String(modId)
          )
    const installedMod = installedFiles[0]
    // Not tracked in the installed list, so DLL presence drives its button state.
    // The loader this very mod page publishes, if any. Its button reflects DLL presence
    // rather than the installed-mods list. Loader mod pages are modworkshop-only. A
    // Nexus mod id lives in a different id space and must never be looked up here.
    const thisLoader = isNexus ? undefined : loaderForModId(activeGame, modId)
    const isLoaderMod = thisLoader !== undefined
    const loaderModInstalled = thisLoader ? (loaderState[thisLoader.id] ?? null) : null

    // Full-size banner via the disk cache. The CDN sends no cache headers, so a
    // direct URL costs a download or revalidation round-trip on every page visit.
    const bannerSrc = useThumbnail((detail?.banner ?? mod?.thumbnail)?.file, true)

    const fetchData = useCallback(() => {
        setError(null)
        markForegroundActivity()

        // Mod and files/links fetch in parallel; each resolves independently so
        // the header renders as soon as mod data is available.
        ;(isNexus ? getCachedNexusMod(activeGame, modId) : getCachedMod(modId))
            .then((modData) => {
                setDetail(modData)
                setDetailsLoading(false)
            })
            .catch((e) => setError(String(e)))
            .finally(() => {
                setLoading(false)
                markForegroundActivity()
            })

        // Nexus has no links concept, so only files are fetched there; links stays [].
        if (isNexus) {
            getCachedNexusModFiles(activeGame, modId)
                .then(setFiles)
                .catch(() => {})
                .finally(() => {
                    setFilesLoading(false)
                    markForegroundActivity()
                })
            return
        }
        Promise.all([getCachedModFiles(modId), getCachedModLinks(modId)])
            .then(([filesData, linksData]) => {
                setFiles(filesData)
                setLinks(linksData)
            })
            .catch(() => {})
            .finally(() => {
                setFilesLoading(false)
                markForegroundActivity()
            })
    }, [modId, isNexus, activeGame])

    useEffect(() => {
        fetchData()
    }, [fetchData])

    useEffect(() => {
        return api.onDownloadProgress(({ download_id, downloaded, total }) => {
            setDownloadMap((prev) => {
                const next = new Map(prev).set(download_id, { downloaded, total })
                // nxm downloads report under "nxm:{gameId}:{modId}:{fileId}", not the
                // "file:{modId}:{fileId}" key DownloadsTab reads for a file's own
                // progress, so a Nexus install mirrors into that key too once it's
                // confirmed to belong to this page's mod.
                if (isNexus) {
                    const [prefix, gameId, evModId, fileId] = download_id.split(':')
                    if (prefix === 'nxm' && gameId === activeGame && Number(evModId) === modId) {
                        next.set(`file:${modId}:${fileId}`, { downloaded, total })
                    }
                }
                return next
            })
        })
    }, [isNexus, activeGame, modId])

    // A Nexus file download arrives via the OS nxm:// deep link, resolved by a second
    // app instance rather than anything this page triggered directly, so its progress
    // is driven by these events rather than a promise. DownloadsTab owns the visible
    // error banner for a failure, since it is scoped to one file's download.
    useEffect(() => {
        if (!isNexus) return
        const offStarted = api.onNxmInstallStarted(({ gameId, modId: evModId, fileId }) => {
            if (gameId !== activeGame || evModId !== modId) return
            setDownloadMap((prev) =>
                new Map(prev).set(`file:${modId}:${fileId}`, { downloaded: 0, total: 0 })
            )
        })
        const offComplete = api.onNxmInstallComplete(({ gameId, modId: evModId, fileId }) => {
            if (gameId !== activeGame || evModId !== modId) return
            setDownloadMap((prev) => {
                const next = new Map(prev)
                next.delete(`file:${modId}:${fileId}`)
                return next
            })
        })
        const offFailed = api.onNxmInstallFailed(() => setDownloadMap(new Map()))
        return () => {
            offStarted()
            offComplete()
            offFailed()
        }
    }, [isNexus, activeGame, modId])

    const images = detail?.images ?? []

    useEffect(() => {
        if (!isActive) return
        function onKey(e: KeyboardEvent) {
            if (lightboxIndex !== null) {
                if (e.key === 'Escape') setLightboxIndex(null)
                else if (e.key === 'ArrowLeft')
                    setLightboxIndex((i) => (i! > 0 ? i! - 1 : images.length - 1))
                else if (e.key === 'ArrowRight')
                    setLightboxIndex((i) => (i! < images.length - 1 ? i! + 1 : 0))
                return
            }
            if (e.key === 'Escape') onBack()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [isActive, lightboxIndex, images.length, onBack])

    async function handleInstall() {
        if (!gamePath || !mod) return
        // No in-app install trigger for Nexus. The free-tier flow is the site's own
        // "Mod Manager Download" button, which hands back an nxm:// link Modrex
        // registers and handles. Matches NexusBrowsePage's openOnNexus.
        if (isNexus) {
            if (nexusDomain) {
                api.openExternal(
                    `https://www.nexusmods.com/${nexusDomain}/mods/${mod.id}?tab=files`
                )
            }
            return
        }
        if (mod.download?.url && !mod.download.download_url) {
            api.openExternal(mod.download.url)
            return
        }
        // Dep check runs here, before FileSelectModal, because multi-file mods
        // (download === null, files.length > 1) go through FileSelectModal which has
        // no dep check of its own, so doInstall is never reached for them.
        let checkedMod = detail
        if (!checkedMod) {
            checkedMod = await getCachedMod(modId)
            setDetail(checkedMod)
        }
        const depResult = await resolveDepCheck(
            modId,
            checkedMod,
            gamePath,
            activeGame,
            installed,
            loaderState
        )
        if (depResult) {
            setLoaderState(depResult.loaderState)

            setShowDepsWarning(true)
            return
        }
        if (mod.download === null && files.length > 1) {
            setShowFileSelect(true)
            return
        }
        const checkType = mod.download?.type ?? (files.length === 1 ? files[0].type : undefined)
        const checkUrl =
            mod.download?.download_url ?? (files.length === 1 ? files[0].download_url : undefined)
        if (isUnsupportedFormat(checkType, checkUrl)) {
            setShowHeaderFormatWarning(true)
            return
        }
        try {
            await crimeBossInstallTarget.runInstall(mod.id, mod.name, doInstall)
        } catch (e) {
            setInstallError(String(e))
        }
    }

    async function doInstall() {
        if (!gamePath || !mod) return
        setInstallError(null)
        setActionLoading(true)
        try {
            // A loader with a direct download installs through its own command; UE4SS
            // (viaModFlow) has no canonical host and rides the normal mod install.
            if (thisLoader && !thisLoader.viaModFlow) {
                await installLoader(mod.id)
            } else {
                const outcome = await api.installMod(mod.id, gamePath, activeGame)
                if (
                    handleInstallOutcome(outcome, {
                        onZipMultiPak: setZipPickerData,
                        onHostModPack: setHostPackData,
                        onCbFlatArchive: setCbFlatArchiveData,
                        onUnrecognizedArchive: () => setUnrecognizedModId(mod.id),
                    })
                ) {
                    return
                }
            }
            await onRefreshInstalled()
        } finally {
            setDownloadMap((prev) => {
                const next = new Map(prev)
                next.delete(`mod:${modId}`)
                return next
            })
            setActionLoading(false)
        }
    }

    // loaderModId is the dependency's modworkshop id, or null for an offsite BLT dep
    // (SuperBLT has no mod page).
    async function handleInstallLoader(loaderModId: number | null) {
        setInstallError(null)
        try {
            await installLoader(loaderModId)
        } catch (e) {
            setInstallError(String(e))
        }
    }

    async function handleUninstall() {
        if (!gamePath || installedFiles.length === 0) return
        setActionLoading(true)
        try {
            for (const m of installedFiles) await api.uninstallMod(m.uid, gamePath, activeGame)
            await onRefreshInstalled()
        } finally {
            setActionLoading(false)
        }
    }

    async function handleEnable() {
        if (!gamePath || installedFiles.length === 0) return
        setActionLoading(true)
        setInstallError(null)
        try {
            const failures = await attemptAll(
                installedFiles,
                (m) => m.name,
                (m) => api.enableMod(m.uid, gamePath, activeGame)
            )
            setInstallError(describeFailures(failures))
        } finally {
            await onRefreshInstalled()
            setActionLoading(false)
        }
    }

    async function handleDisable() {
        if (!gamePath || installedFiles.length === 0) return
        setActionLoading(true)
        setInstallError(null)
        try {
            const failures = await attemptAll(
                installedFiles,
                (m) => m.name,
                (m) => api.disableMod(m.uid, gamePath, activeGame)
            )
            setInstallError(describeFailures(failures))
        } finally {
            await onRefreshInstalled()
            setActionLoading(false)
        }
    }

    const canAct = !!gamePath && !actionLoading && !loading

    const allDeps: ModDependency[] = collectDeps(detail)

    // Hosted loader mods (PDTHModOverrides, DAHM, UE4SS) install as game-root/Binaries
    // files and are checked by presence, not the installed-mods list.
    // SuperBLT is offsite (no mod page), so it is matched by name, and only for PD2;
    // see isLoaderDep. Every other loader is matched by its dependency id.
    const needsBltCheck = activeGame === 'pd2' && allDeps.some(isLoaderDep)
    // Loader ids to presence-check: any this mod depends on, plus this mod's own loader
    // when the page itself is a loader's mod page.
    const depModIds = allDeps.flatMap((d) => (d.mod ? [d.mod.id] : []))
    const neededLoaderIds = loadersForGame(activeGame)
        .filter((l) => l.modworkshopIds.some((id) => depModIds.includes(id)))
        .map((l) => l.id)
    if (thisLoader) neededLoaderIds.push(thisLoader.id)
    if (needsBltCheck) neededLoaderIds.push('superblt')
    const loaderCheckKey = [...new Set(neededLoaderIds)].sort().join(',')

    const missingRequired = missingRequiredDeps(
        allDeps,
        installed,
        loaderState.superblt ?? null,
        loaderModIds
    )

    useEffect(() => {
        if (!gamePath || loaderCheckKey === '') return
        let cancelled = false
        for (const id of loaderCheckKey.split(',')) {
            api.checkLoader(id, activeGame, gamePath).then((v) => {
                if (!cancelled) setLoaderFlag(id, v)
            })
        }
        return () => {
            cancelled = true
        }
    }, [gamePath, loaderCheckKey, activeGame, setLoaderFlag])

    const showChangelogTab = !!detail?.changelog
    const showLicenseTab = !!detail?.license

    // Owner's own donation link wins over the mod-level one, like on modworkshop.
    const ownerDonation = donationInfo(mod?.user.donation_url) ?? donationInfo(detail?.donation)
    const credits = (detail?.members ?? []).filter((m) => m.accepted && CREDIT_LEVELS.has(m.level))
    const showDepsTab =
        !!(detail?.instructs_template?.instructions || detail?.instructions) || allDeps.length > 0

    // Nexus's mod-detail response carries no image gallery at all, just the one
    // thumbnail already shown as the banner. Unlike changelog, license and deps, this
    // is never going to have data for a Nexus mod, so the tab shouldn't exist rather
    // than permanently show "no images".
    const tabs: { id: Tab; label: string }[] = [
        { id: 'description', label: t('detail.tabs.description') },
        ...(isNexus
            ? []
            : [
                  {
                      id: 'images' as Tab,
                      label: images.length
                          ? t('detail.tabs.imagesCount', { count: images.length })
                          : t('detail.tabs.images'),
                  },
              ]),
        {
            id: 'downloads',
            label:
                files.length + links.length
                    ? t('detail.tabs.downloadsCount', { count: files.length + links.length })
                    : t('detail.tabs.downloads'),
        },
        ...(showChangelogTab
            ? [{ id: 'changelog' as Tab, label: t('detail.tabs.changelog') }]
            : []),
        ...(showLicenseTab ? [{ id: 'license' as Tab, label: t('detail.tabs.license') }] : []),
        ...(showDepsTab ? [{ id: 'deps' as Tab, label: t('detail.tabs.deps') }] : []),
    ]

    return (
        <div className="h-full flex flex-col">
            {crimeBossInstallTarget.pendingChoice && (
                <CrimeBossInstallTargetModal
                    modName={crimeBossInstallTarget.pendingChoice.modName}
                    busy={crimeBossInstallTarget.relocating}
                    error={crimeBossInstallTarget.error}
                    onChoose={crimeBossInstallTarget.confirmChoice}
                    onCancel={crimeBossInstallTarget.cancelChoice}
                />
            )}
            {zipPickerData && gamePath && (
                <ZipPickerModal
                    payload={zipPickerData}
                    gamePath={gamePath}
                    installedFiles={installedFiles}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setZipPickerData(null)}
                />
            )}
            {hostPackData && gamePath && (
                <HostPackModal
                    payload={hostPackData}
                    gamePath={gamePath}
                    installed={installed}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setHostPackData(null)}
                />
            )}
            {cbFlatArchiveData && gamePath && (
                <CrimeBossFlatArchiveModal
                    payload={cbFlatArchiveData}
                    gamePath={gamePath}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setCbFlatArchiveData(null)}
                />
            )}
            {unrecognizedModId !== null && (
                <UnrecognizedArchiveModal
                    modId={unrecognizedModId}
                    onClose={() => setUnrecognizedModId(null)}
                />
            )}
            {showFileSelect && mod && (
                <FileSelectModal
                    mod={mod}
                    files={files}
                    gamePath={gamePath}
                    installedFiles={installedFiles}
                    gameId={activeGame}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setShowFileSelect(false)}
                />
            )}
            {showHeaderFormatWarning && (
                <NonPakConfirmModal
                    onConfirm={async () => {
                        setShowHeaderFormatWarning(false)
                        try {
                            await crimeBossInstallTarget.runInstall(mod!.id, mod!.name, doInstall)
                        } catch (e) {
                            setInstallError(String(e))
                        }
                    }}
                    onCancel={() => setShowHeaderFormatWarning(false)}
                />
            )}
            {showDepsWarning && (
                <DepsWarningModal
                    modId={modId}
                    missingRequired={missingRequired}
                    gamePath={gamePath}
                    gameId={activeGame}
                    loaderModIds={loadersForGame(activeGame).flatMap((l) => l.modworkshopIds)}
                    onInstallLoader={handleInstallLoader}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => setShowDepsWarning(false)}
                    onGotIt={async (permanent) => {
                        sessionStorage.setItem(`depsWarningDismissed-${modId}`, '1')
                        if (permanent) await api.dismissDepsWarning(modId)
                        setShowDepsWarning(false)
                    }}
                    onOpenDetail={
                        onOpenDetail
                            ? (depModId) => {
                                  setShowDepsWarning(false)
                                  onOpenDetail(depModId)
                              }
                            : undefined
                    }
                />
            )}
            <div className="px-6 py-3 border-b border-border shrink-0 flex items-center gap-3 relative">
                <button
                    onClick={onBack}
                    className="-mx-2 px-2 py-1 rounded text-sm text-text-muted hover:text-text hover:bg-surface-hover transition-colors flex items-center gap-1.5 shrink-0"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t('detail.back')}
                </button>
                {mod && (
                    <span className="text-sm text-text-subtle truncate hidden sm:block">
                        {mod.name}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                    {mod && installedMod && !isLoaderMod && (
                        <>
                            <Toggle
                                checked={installedFiles.every((m) => m.enabled)}
                                onChange={(v) => (v ? handleEnable() : handleDisable())}
                                disabled={!canAct}
                            />
                            <Tooltip content={t('common.remove')}>
                                <Button
                                    variant="danger"
                                    size="icon-md"
                                    disabled={!canAct}
                                    onClick={handleUninstall}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </Tooltip>
                        </>
                    )}
                    {mod && isLoaderMod && loaderModInstalled && (
                        <span className="text-xs text-success-text">
                            {t('detail.deps.statusInstalled')}
                        </span>
                    )}
                    {mod && installedFiles.length === 0 && !(isLoaderMod && loaderModInstalled) && (
                        <div className="flex flex-col items-end gap-1">
                            {mod.disable_mod_managers ? (
                                <span className="text-xs text-text-muted">
                                    {t('common.modManagerDisabled')}
                                </span>
                            ) : mod.has_download ? (
                                <>
                                    {mod.download?.url && !mod.download.download_url ? (
                                        <Button
                                            variant="accent"
                                            size="lg"
                                            onClick={() => api.openExternal(mod.download!.url!)}
                                        >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            {t('common.openLink')}
                                        </Button>
                                    ) : (
                                        <Button
                                            variant="accent"
                                            size="lg"
                                            disabled={!canAct}
                                            onClick={handleInstall}
                                        >
                                            {!actionLoading && <Download className="w-3.5 h-3.5" />}
                                            {actionLoading
                                                ? (() => {
                                                      const p = downloadMap.get(`mod:${modId}`)
                                                      return p
                                                          ? p.total > 0
                                                              ? `${Math.round((p.downloaded / p.total) * 100)}%`
                                                              : t('common.downloading')
                                                          : t('common.installing')
                                                  })()
                                                : t('common.install')}
                                        </Button>
                                    )}
                                    {isUnsupportedFormat(
                                        mod.download?.type ?? undefined,
                                        mod.download?.download_url ?? undefined
                                    ) && (
                                        <span className="flex items-center gap-1 text-xs text-warning">
                                            <AlertTriangle className="w-3 h-3 shrink-0" />
                                            {t('common.nonPakWarning')}
                                        </span>
                                    )}
                                </>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>
            {(() => {
                const p = downloadMap.get(`mod:${modId}`)
                return p ? (
                    <div className="h-0.5 bg-surface-active shrink-0">
                        {p.total > 0 ? (
                            <div
                                className="h-full bg-accent transition-[width] duration-100"
                                style={{
                                    width: `${Math.round((p.downloaded / p.total) * 100)}%`,
                                }}
                            />
                        ) : (
                            <div className="h-full bg-accent animate-pulse w-full" />
                        )}
                    </div>
                ) : null
            })()}

            {installError && (
                <div className="px-6 py-2 bg-danger/20 border-b border-danger/30 text-xs text-danger-text flex items-center justify-between shrink-0">
                    <span>{installError}</span>
                    <button
                        onClick={() => setInstallError(null)}
                        className="ml-2 shrink-0 p-1 rounded text-danger-text/70 hover:text-danger-text hover:bg-danger/20 transition-colors"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {loading && <ModDetailSkeleton />}

            {error && (
                <div className="flex items-center justify-center flex-1">
                    <div className="text-sm text-danger-text">{error}</div>
                </div>
            )}

            {!loading && !error && mod && (
                <div className="flex-1 overflow-y-auto">
                    {/* The banner slot is always rendered, including for mods that ship no
                        image. Dropping it moves the title, tabs and info card up by the
                        banner's full height, and the loading skeleton reserves the same box,
                        so nothing shifts once data arrives. The icon marks a mod that has no
                        image at all, and waits for the detail fetch so it never flashes in
                        front of a banner that is still on its way. */}
                    {bannerSrc ? (
                        <img
                            src={bannerSrc}
                            alt={mod.name}
                            loading="lazy"
                            className="w-full aspect-[4/1] max-h-72 object-cover"
                        />
                    ) : (
                        <div className="w-full aspect-[4/1] max-h-72 bg-surface-raised flex items-center justify-center">
                            {!(detail?.banner ?? mod.thumbnail) && !detailsLoading && (
                                <ImageIcon
                                    className="w-8 h-8 text-text-subtle"
                                    aria-hidden="true"
                                />
                            )}
                        </div>
                    )}

                    <div className="flex items-start gap-6 px-6">
                        <div className="min-w-0 flex-1">
                            <div className="py-5 border-b border-border">
                                <h1 className="text-xl font-bold leading-tight">{mod.name}</h1>
                            </div>

                            <Tabs.Root defaultValue="description">
                                <Tabs.List className="flex border-b border-border">
                                    {tabs.map((tabItem) => (
                                        <Tabs.Trigger
                                            key={tabItem.id}
                                            value={tabItem.id}
                                            className="relative text-xs px-4 py-3 border-b-2 border-transparent transition-colors text-text-subtle hover:text-text-muted before:content-[''] before:absolute before:inset-x-1 before:inset-y-1.5 before:rounded before:transition-colors hover:before:bg-surface-hover data-[state=active]:border-accent data-[state=active]:text-accent focus:outline-none"
                                        >
                                            <span className="relative">{tabItem.label}</span>
                                        </Tabs.Trigger>
                                    ))}
                                    {detailsLoading && (
                                        <div
                                            className="px-3 py-2.5 flex items-center animate-pulse"
                                            aria-hidden="true"
                                        >
                                            <SkeletonBar className="h-2.5 w-14" />
                                        </div>
                                    )}
                                </Tabs.List>

                                <Tabs.Content
                                    value="description"
                                    className="py-5 focus:outline-none"
                                >
                                    {isNexus ? (
                                        <NexusDescription text={mod.desc} />
                                    ) : (
                                        <DescriptionTab mod={mod} />
                                    )}
                                </Tabs.Content>
                                <Tabs.Content value="changelog" className="py-5 focus:outline-none">
                                    {detail && <ChangelogTab mod={detail} />}
                                </Tabs.Content>
                                <Tabs.Content value="license" className="py-5 focus:outline-none">
                                    {detail && <LicenseTab mod={detail} />}
                                </Tabs.Content>
                                <Tabs.Content value="images" className="py-5 focus:outline-none">
                                    <ImagesTab
                                        images={images}
                                        loading={detailsLoading}
                                        onOpenImage={setLightboxIndex}
                                    />
                                </Tabs.Content>
                                <Tabs.Content value="downloads" className="py-5 focus:outline-none">
                                    <DownloadsTab
                                        files={files}
                                        links={links}
                                        loading={filesLoading}
                                        mod={mod}
                                        images={images}
                                        gamePath={gamePath}
                                        installed={installed}
                                        installedFiles={installedFiles}
                                        downloadMap={downloadMap}
                                        activeGame={activeGame}
                                        onRefreshInstalled={onRefreshInstalled}
                                        nexusUrl={
                                            isNexus && nexusDomain
                                                ? `https://www.nexusmods.com/${nexusDomain}/mods/${mod.id}?tab=files`
                                                : null
                                        }
                                        isNexus={isNexus}
                                    />
                                </Tabs.Content>
                                <Tabs.Content value="deps" className="py-5 focus:outline-none">
                                    <DepsTab
                                        instructions={detail?.instructions ?? null}
                                        instructsTemplate={detail?.instructs_template ?? null}
                                        deps={allDeps}
                                        installed={installed}
                                        gamePath={gamePath}
                                        activeGame={activeGame}
                                        loaderInstalled={loaderState.superblt ?? null}
                                        loaderModIds={loaderModIds}
                                        onInstallLoader={handleInstallLoader}
                                        onRefreshInstalled={onRefreshInstalled}
                                        onOpenDetail={onOpenDetail}
                                    />
                                </Tabs.Content>
                            </Tabs.Root>
                        </div>

                        <aside className="w-1/3 min-w-64 max-w-md shrink-0 sticky top-5 my-5 rounded-lg bg-surface-hover border border-border p-4 flex flex-col gap-3">
                            <div
                                className={`grid ${mod.views > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}
                            >
                                <Stat
                                    value={mod.downloads.toLocaleString()}
                                    label={t('detail.stats.downloads')}
                                />
                                <Stat
                                    value={mod.likes.toLocaleString()}
                                    label={t('detail.stats.likes')}
                                />
                                {mod.views > 0 && (
                                    <Stat
                                        value={mod.views.toLocaleString()}
                                        label={t('detail.stats.views')}
                                    />
                                )}
                            </div>
                            <div className="h-px bg-border" />
                            <InfoRow
                                icon={<TagIcon className="w-3.5 h-3.5" />}
                                label={t('detail.info.version')}
                                value={installedMod?.version ?? mod.version}
                            />
                            <InfoRow
                                icon={<CalendarDays className="w-3.5 h-3.5" />}
                                label={t('detail.info.published')}
                                value={formatDate(mod.published_at)}
                            />
                            <InfoRow
                                icon={<Clock className="w-3.5 h-3.5" />}
                                label={t('detail.info.updated')}
                                value={formatDate(mod.bumped_at)}
                            />
                            {detail?.repo_url && (
                                <InfoRow
                                    icon={<BrandIcon icon={siGit} />}
                                    label={t('detail.info.repository')}
                                    value={
                                        <button
                                            onClick={() => api.openExternal(detail.repo_url!)}
                                            className="inline-flex items-center gap-1 font-medium text-text hover:text-accent-bright transition-colors"
                                        >
                                            {(() => {
                                                const icon = repoHostIcon(detail.repo_url!)
                                                return icon ? (
                                                    <BrandIcon icon={icon} />
                                                ) : (
                                                    <LinkIcon className="w-3 h-3 shrink-0" />
                                                )
                                            })()}
                                            {t('detail.info.link')}
                                        </button>
                                    }
                                />
                            )}
                            {detailsLoading ? (
                                <>
                                    <div
                                        className="flex items-center gap-1.5 text-xs text-text-subtle"
                                        aria-hidden="true"
                                    >
                                        <TagIcon className="w-3.5 h-3.5" />
                                        {t('detail.info.tags')}
                                    </div>
                                    <div
                                        className="flex flex-wrap gap-1.5 animate-pulse"
                                        aria-hidden="true"
                                    >
                                        <SkeletonBar className="h-5 w-16 rounded-full" />
                                        <SkeletonBar className="h-5 w-20 rounded-full" />
                                        <SkeletonBar className="h-5 w-12 rounded-full" />
                                    </div>
                                </>
                            ) : detail?.tags && detail.tags.length > 0 ? (
                                <>
                                    <div className="flex items-center gap-1.5 text-xs text-text-subtle">
                                        <TagIcon className="w-3.5 h-3.5" />
                                        {t('detail.info.tags')}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {detail.tags.map((tag) => (
                                            <span
                                                key={tag.id}
                                                className="text-xs px-2 py-0.5 rounded-full border"
                                                style={{
                                                    borderColor: tag.color + '80',
                                                    color: tag.color,
                                                    backgroundColor: tag.color + '18',
                                                }}
                                            >
                                                {tag.name}
                                            </span>
                                        ))}
                                    </div>
                                </>
                            ) : null}
                            <div className="h-px bg-border" />
                            <div className="flex items-center gap-1.5 text-xs text-text-subtle">
                                <Users className="w-3.5 h-3.5" />
                                {t('detail.info.members')}
                            </div>
                            <MemberRow
                                name={mod.user.name}
                                role={t('detail.info.owner')}
                                profileUrl={
                                    mod.user.id == null
                                        ? undefined
                                        : isNexus
                                          ? `https://www.nexusmods.com/users/${mod.user.id}`
                                          : `https://modworkshop.net/user/${mod.user.id}`
                                }
                                avatar={mod.user.avatar ?? undefined}
                                avatarHasThumb={mod.user.avatar_has_thumb ?? undefined}
                                fallbackIcon={
                                    isNexus ? (
                                        <NexusIcon className="w-4 h-4 text-text-subtle" />
                                    ) : undefined
                                }
                                donation={ownerDonation}
                            />
                            {credits.map((m) => (
                                <MemberRow
                                    key={m.id}
                                    name={m.name}
                                    role={creditLevelLabel(m.level)}
                                    profileUrl={`https://modworkshop.net/user/${m.id}`}
                                    avatar={m.avatar ?? undefined}
                                    avatarHasThumb={m.avatar_has_thumb ?? undefined}
                                    donation={donationInfo(m.donation_url)}
                                />
                            ))}
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                                {mod.id > 0 && (isNexus ? !!nexusDomain : true) && (
                                    <button
                                        onClick={() =>
                                            api.openExternal(
                                                isNexus
                                                    ? `https://www.nexusmods.com/${nexusDomain}/mods/${mod.id}`
                                                    : `https://modworkshop.net/mod/${mod.id}`
                                            )
                                        }
                                        className="text-accent-bright hover:underline inline-flex items-center gap-0.5"
                                    >
                                        {isNexus ? t('detail.viewOnNexus') : t('detail.viewOnSite')}
                                        <ExternalLink className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        </aside>
                    </div>
                </div>
            )}

            {lightboxIndex !== null && images.length > 0 && (
                <div
                    className="absolute inset-0 bg-black/90 flex items-center justify-center z-50"
                    onClick={() => setLightboxIndex(null)}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            setLightboxIndex((i) => (i! > 0 ? i! - 1 : images.length - 1))
                        }}
                        className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors"
                    >
                        <ChevronLeft className="w-6 h-6" />
                    </button>

                    <LightboxImage file={images[lightboxIndex].file} />

                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            setLightboxIndex((i) => (i! < images.length - 1 ? i! + 1 : 0))
                        }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors"
                    >
                        <ChevronRight className="w-6 h-6" />
                    </button>

                    <button
                        onClick={() => setLightboxIndex(null)}
                        className="absolute top-4 right-4 p-1 rounded-full text-white/70 hover:text-white hover:bg-black/40 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                    {images.length > 1 && (
                        <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/60">
                            {lightboxIndex + 1} / {images.length}
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}

function Stat({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex flex-col items-center gap-0.5">
            <span className="font-semibold">{value}</span>
            <span className="text-xs text-text-subtle">{label}</span>
        </div>
    )
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
    return (
        <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-text-subtle">
                {icon}
                {label}
            </span>
            <span className="ml-auto text-right font-medium text-text">{value}</span>
        </div>
    )
}

function MemberRow({
    name,
    role,
    profileUrl,
    avatar,
    avatarHasThumb,
    fallbackIcon,
    donation,
}: {
    name: string
    role: string
    profileUrl?: string
    avatar?: string
    avatarHasThumb?: boolean
    fallbackIcon?: ReactNode
    donation: { url: string; label: string } | null
}) {
    const src = avatar ? `${AVATAR_BASE_URL}/${avatarHasThumb ? 'thumbnail_' : ''}${avatar}` : null
    const person = (
        <>
            {src ? (
                <img
                    src={src}
                    alt={name}
                    loading="lazy"
                    className="w-9 h-9 rounded-md object-cover shrink-0"
                />
            ) : fallbackIcon ? (
                <div className="w-9 h-9 rounded-md bg-surface-active shrink-0 flex items-center justify-center">
                    {fallbackIcon}
                </div>
            ) : (
                <div className="w-9 h-9 rounded-md bg-surface-active shrink-0" />
            )}
            <div className="min-w-0">
                <div className="text-xs font-medium text-text truncate group-hover:text-accent-bright">
                    {name}
                </div>
                <div className="text-xs text-text-subtle">{role}</div>
            </div>
        </>
    )
    return (
        <div className="flex items-center gap-2.5">
            {profileUrl ? (
                <Tooltip content={t('detail.deps.openOnSite')}>
                    <button
                        onClick={() => api.openExternal(profileUrl)}
                        className="group flex items-center gap-2.5 min-w-0 text-left"
                    >
                        {person}
                    </button>
                </Tooltip>
            ) : (
                person
            )}
            {donation && (
                <span className="ml-auto">
                    <DonateButton donation={donation} />
                </span>
            )}
        </div>
    )
}

function DonateButton({ donation }: { donation: { url: string; label: string } }) {
    return (
        <Tooltip content={t('detail.donate')}>
            <Button
                variant="ghost-accent"
                size="sm"
                onClick={() => api.openExternal(donation.url)}
                className="px-2 shrink-0 hover:bg-surface-active"
            >
                <Heart className="w-3 h-3" />
                {donation.label}
            </Button>
        </Tooltip>
    )
}

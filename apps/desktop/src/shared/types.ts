import type { ModFolder } from './bindings'

export interface ModImage {
    id: number
    file: string
    type: string
    size: number
    display_order: number
    visible: boolean
    has_thumb: boolean
}

export interface ModDependency {
    id: number
    // null for offsite dependencies (hosted outside modworkshop, e.g. SuperBLT)
    mod_id: number | null
    name: string | null
    url: string | null
    optional: boolean
    // author-defined install order; deps render sorted by it like on modworkshop
    order: number | null
    // the LISTING shape, not a full detail: modworkshop returns a summary here and the
    // deps tab only reads summary fields off it
    mod: ModSummary | null
}

export interface InstructsTemplate {
    id: number
    name: string
    instructions: string
    dependencies: ModDependency[]
}

// A user attached to a mod's credits (member of the mod page). level is the
// modworkshop role: collaborator | maintainer | contributor | viewer.
export interface ModMember {
    id: number
    name: string
    level: string
    accepted: boolean
    donation_url: string | null
    avatar: string | null
    avatar_has_thumb: boolean | null
}

export interface ModTag {
    id: number
    name: string
    color: string
}

/**
 * A mod as a LIST returns it. Both browse results and the bulk installed-metadata
 * refresh produce this shape, which lacks the images, banner, dependencies,
 * instructs_template and tags that only /mods/{id} returns.
 *
 * Must stay structurally identical to the generated ModSummary in bindings.ts. api.ts
 * assigns the command result to it WITHOUT a cast, so any drift is a compile error there.
 * Nullable fields are written | null rather than optional because Rust Option exports that
 * way, and loosening them to ?: breaks that check rather than fixing anything.
 *
 * It does NOT prevent a summary being used where a Mod is expected: every field Mod adds is
 * optional and TypeScript is structural, so ModSummary still satisfies Mod. Closing that
 * needs the detail path typed in Rust too, so until then modCache.ts's installedMetaCache
 * invariant stays a prose rule.
 */
export interface ModSummary {
    id: number
    name: string
    desc: string
    short_desc: string
    version: string
    downloads: number
    likes: number
    views: number
    published_at: string
    bumped_at: string
    category_id: number
    has_download: boolean
    disable_mod_managers: boolean | null
    thumbnail: { file: string; has_thumb: boolean | null } | null
    download: {
        id: number
        version: string
        size: number | null
        type: string | null
        download_url: string | null
        url: string | null
    } | null
    user: {
        // absent on locally synthesized mods (installedUtils.syntheticMod)
        id: number | null
        name: string
        donation_url: string | null
        avatar: string | null
        avatar_has_thumb: boolean | null
    }
}

/** A mod as /mods/{id} returns it: a summary plus the fields only the detail call carries. */
export interface Mod extends ModSummary {
    changelog: string | null
    instructions: string | null
    license: string | null
    repo_url: string | null
    donation: string | null
    banner: ModImage | null
    // Collections are required but may be empty: Rust normalizes an absent array to an
    // empty one, so consumers need no ?? [] fallback of their own at each use.
    images: ModImage[]
    dependencies: ModDependency[]
    instructs_template: InstructsTemplate | null
    tags: ModTag[]
    members: ModMember[]
}

export interface ModLink {
    id: number
    name: string
    url: string
    desc: string | null
    label: string | null
    version: string | null
    image_id: number | null
    downloads: number | null
    created_at: string | null
}

export interface ModFile {
    id: number
    name: string
    version: string
    size: number
    type: string | null
    download_url: string
    url: string | null
    image_id: number | null
    desc: string | null
    label: string | null
    downloads: number | null
    created_at: string | null
}

export interface Category {
    id: number
    name: string
}

export const THUMBNAIL_BASE_URL = 'https://storage.modworkshop.net/mods/images'
export const AVATAR_BASE_URL = 'https://storage.modworkshop.net/users/images'
export const GAME_STORAGE_KEY = 'pd3'

// Game identity data is shared with the indexer and site. GAME_STORAGE_KEY remains the
// desktop's persisted selected-game default, rather than part of the shared registry.
export { GAMES, isGameId } from '@modrex/games'
export type { GameId, GameSpec } from '@modrex/games'

// Wire types owned by the Rust side and generated into bindings.ts; re-exported
// here so renderer code keeps one import path for shared shapes.
export type { ModFolder, TopLevelItem, IndexModFile, NewsItem, NewsResult } from './bindings'
export type { IdentityConfidence, IdentityEvidence, ModIdentity } from './bindings'

import type { IdentityConfidence, IdentityEvidence } from './bindings'

export interface InstalledMod {
    uid: string // unique per installed file, stable identity across renames
    // The installed record's own key, for React keys, drag and drop and command targets.
    // What the mod *is* lives in `identity`; where to get it lives in source/remoteId.
    id: number
    name: string
    version: string
    filename: string
    enabled: boolean
    installedAt: string
    source?: string // mod source slug; absent = "modworkshop"
    remoteId?: string // source-native mod id; modworkshop identity stays in id/fileId
    fileRemoteId?: string // source-native file id
    author?: string // only recorded for non-modworkshop sources
    thumbnailUrl?: string // absolute CDN URL; only recorded for non-modworkshop sources
    fileId?: number
    fileType?: string
    sha256?: string
    priority?: number // higher = loads later in UE5 = overrides lower-priority mods
    missing?: boolean
    folderId?: string | null // null or absent = root level
    archiveBroken?: boolean
    location?: string // scan target tag; absent = primary target
    // Whether version is comparable. Kept out of the version string so "unknown" and
    // "outdated" are never mistaken for real version values.
    updateStatus?: 'known' | 'unknown' | 'outdated'
    // Nexus content-index lookup already found nothing (or an ambiguous result) for
    // this mod, a permanent miss until Nexus indexes it, so it is never re-queried.
    nexusContentMissed?: boolean
    // Which project this is, independent of any catalog, and how that was established.
    // Present for mods whose own files say what they are, whether or not ModWorkshop or
    // Nexus has ever heard of them. namespace is a field, never a prefix to parse out of key.
    identity?: {
        namespace: string
        key: string
        confidence: IdentityConfidence
        evidence: IdentityEvidence
    }
    // What the mod's own files declare, used for display when no catalog describes the mod.
    declared?: { name?: string; author?: string; version?: string }
}

export interface ModsState {
    folders: ModFolder[]
    mods: InstalledMod[]
}

export type SortOption =
    'downloads' | 'likes' | 'views' | 'score' | 'published_at' | 'bumped_at' | 'name' | 'best_match'

export interface ListModsParams {
    query?: string
    limit?: number
    sort?: SortOption
    category_id?: number
    page?: number
    ids?: number[]
    tags?: number[]
    block_tags?: number[]
}

export interface Paginated<T> {
    data: T[]
    meta: {
        current_page: number
        last_page: number
        per_page: number
        total: number
    }
}

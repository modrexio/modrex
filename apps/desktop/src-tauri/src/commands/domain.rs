//! Neutral mod types the renderer consumes, and the modworkshop translation into them.
//!
//! Two structs per shape, deliberately:
//!
//! The private Wire types are what modworkshop actually sends. They carry a
//! container-level serde(default) because the API omits fields inconsistently (type and
//! size are absent on link-type downloads, avatar on users who never set one).
//! Deserializing into a struct WITHOUT defaults turns a response missing one field into a
//! hard error that empties the whole browse page, so the wire layer stays maximally
//! forgiving.
//!
//! The public types are what crosses IPC, and their fields are required. Normalizing in
//! Rust (absent string becomes empty, absent count becomes zero) is what lets the renderer
//! keep strong types: specta derives optionality from the serde attributes, so one struct
//! carrying both derives plus serde(default) exports EVERY field as optional. Option
//! survives only where absence is real and the renderer already branches on it.

use serde::{Deserialize, Deserializer, Serialize};

/// Treats an explicit JSON null as the field's default.
///
/// serde(default) only covers an ABSENT field. modworkshop also sends explicit nulls for
/// values it has no data for (a mod with no category sends "category_id": null), and
/// without this those hit "invalid type: null, expected i64" and fail the whole response,
/// which empties the browse page over one field on one mod. Every non-Option field below
/// carries this for that reason.
fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireThumbnail {
    #[serde(deserialize_with = "null_default")]
    file: String,
    has_thumb: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireDownload {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    version: String,
    size: Option<i64>,
    #[serde(rename = "type")]
    kind: Option<String>,
    download_url: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireUser {
    id: Option<i64>,
    #[serde(deserialize_with = "null_default")]
    name: String,
    donation_url: Option<String>,
    avatar: Option<String>,
    avatar_has_thumb: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireModSummary {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    desc: String,
    #[serde(deserialize_with = "null_default")]
    short_desc: String,
    #[serde(deserialize_with = "null_default")]
    downloads: i64,
    #[serde(deserialize_with = "null_default")]
    likes: i64,
    #[serde(deserialize_with = "null_default")]
    views: i64,
    #[serde(deserialize_with = "null_default")]
    published_at: String,
    #[serde(deserialize_with = "null_default")]
    bumped_at: String,
    #[serde(deserialize_with = "null_default")]
    category_id: i64,
    #[serde(deserialize_with = "null_default")]
    has_download: bool,
    disable_mod_managers: Option<bool>,
    thumbnail: Option<WireThumbnail>,
    #[serde(deserialize_with = "null_default")]
    user: WireUser,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WirePageMeta {
    #[serde(deserialize_with = "null_default")]
    current_page: i64,
    #[serde(deserialize_with = "null_default")]
    last_page: i64,
    #[serde(deserialize_with = "null_default")]
    per_page: i64,
    #[serde(deserialize_with = "null_default")]
    total: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireModPage {
    #[serde(deserialize_with = "null_default")]
    data: Vec<WireModSummary>,
    #[serde(deserialize_with = "null_default")]
    meta: WirePageMeta,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModThumbnail {
    pub file: String,
    pub has_thumb: Option<bool>,
}

/// The default download attached to a detail response. modworkshop has two shapes here:
/// file-hosted mods carry download_url/type/size, external-link mods carry only url.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModDownload {
    pub id: i64,
    pub version: String,
    pub size: Option<i64>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub download_url: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModUser {
    pub id: Option<i64>,
    pub name: String,
    pub donation_url: Option<String>,
    pub avatar: Option<String>,
    pub avatar_has_thumb: Option<bool>,
}

/// A mod as a listing returns it. Version/default-download and the richer detail fields
/// are deliberately absent because the listing endpoint does not guarantee them.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModSummary {
    pub id: i64,
    pub name: String,
    pub desc: String,
    pub short_desc: String,
    pub downloads: i64,
    pub likes: i64,
    pub views: i64,
    pub published_at: String,
    pub bumped_at: String,
    pub category_id: i64,
    pub has_download: bool,
    pub disable_mod_managers: Option<bool>,
    pub thumbnail: Option<ModThumbnail>,
    pub user: ModUser,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PageMeta {
    pub current_page: i64,
    pub last_page: i64,
    pub per_page: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModPage {
    pub data: Vec<ModSummary>,
    pub meta: PageMeta,
}

impl From<WireThumbnail> for ModThumbnail {
    fn from(w: WireThumbnail) -> Self {
        Self {
            file: w.file,
            has_thumb: w.has_thumb,
        }
    }
}

impl From<WireDownload> for ModDownload {
    fn from(w: WireDownload) -> Self {
        Self {
            id: w.id,
            version: w.version,
            size: w.size,
            kind: w.kind,
            download_url: w.download_url,
            url: w.url,
        }
    }
}

impl From<WireUser> for ModUser {
    fn from(w: WireUser) -> Self {
        Self {
            id: w.id,
            name: w.name,
            donation_url: w.donation_url,
            avatar: w.avatar,
            avatar_has_thumb: w.avatar_has_thumb,
        }
    }
}

impl From<WireModSummary> for ModSummary {
    fn from(w: WireModSummary) -> Self {
        Self {
            id: w.id,
            name: w.name,
            desc: w.desc,
            short_desc: w.short_desc,
            downloads: w.downloads,
            likes: w.likes,
            views: w.views,
            published_at: w.published_at,
            bumped_at: w.bumped_at,
            category_id: w.category_id,
            has_download: w.has_download,
            disable_mod_managers: w.disable_mod_managers,
            thumbnail: w.thumbnail.map(Into::into),
            user: w.user.into(),
        }
    }
}

impl From<WirePageMeta> for PageMeta {
    fn from(w: WirePageMeta) -> Self {
        Self {
            current_page: w.current_page,
            last_page: w.last_page,
            per_page: w.per_page,
            total: w.total,
        }
    }
}

impl From<WireModPage> for ModPage {
    fn from(w: WireModPage) -> Self {
        Self {
            data: w.data.into_iter().map(Into::into).collect(),
            meta: w.meta.into(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireModFile {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    version: String,
    #[serde(deserialize_with = "null_default")]
    size: i64,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(deserialize_with = "null_default")]
    download_url: String,
    url: Option<String>,
    image_id: Option<i64>,
    desc: Option<String>,
    label: Option<String>,
    downloads: Option<i64>,
    created_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireModLink {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    url: String,
    desc: Option<String>,
    label: Option<String>,
    version: Option<String>,
    image_id: Option<i64>,
    downloads: Option<i64>,
    created_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireFilePage {
    #[serde(deserialize_with = "null_default")]
    data: Vec<WireModFile>,
    #[serde(deserialize_with = "null_default")]
    meta: WirePageMeta,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireLinkPage {
    #[serde(deserialize_with = "null_default")]
    data: Vec<WireModLink>,
    #[serde(deserialize_with = "null_default")]
    meta: WirePageMeta,
}

/// One downloadable file on a mod. Distinct from ModDownload above, which is the single
/// default download a listing carries. A mod can publish many files.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModFile {
    pub id: i64,
    pub name: String,
    pub version: String,
    pub size: i64,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub download_url: String,
    pub url: Option<String>,
    pub image_id: Option<i64>,
    pub desc: Option<String>,
    pub label: Option<String>,
    pub downloads: Option<i64>,
    pub created_at: Option<String>,
}

/// An external link a mod lists. Carries url but never download_url/type/size, which is
/// what separates it from a hosted file.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModLink {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub desc: Option<String>,
    pub label: Option<String>,
    pub version: Option<String>,
    pub image_id: Option<i64>,
    pub downloads: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct FilePage {
    pub data: Vec<ModFile>,
    pub meta: PageMeta,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct LinkPage {
    pub data: Vec<ModLink>,
    pub meta: PageMeta,
}

impl From<WireModFile> for ModFile {
    fn from(w: WireModFile) -> Self {
        Self {
            id: w.id,
            name: w.name,
            version: w.version,
            size: w.size,
            kind: w.kind,
            download_url: w.download_url,
            url: w.url,
            image_id: w.image_id,
            desc: w.desc,
            label: w.label,
            downloads: w.downloads,
            created_at: w.created_at,
        }
    }
}

impl From<WireModLink> for ModLink {
    fn from(w: WireModLink) -> Self {
        Self {
            id: w.id,
            name: w.name,
            url: w.url,
            desc: w.desc,
            label: w.label,
            version: w.version,
            image_id: w.image_id,
            downloads: w.downloads,
            created_at: w.created_at,
        }
    }
}

/// Parses a modworkshop file listing into the neutral page shape.
pub fn parse_file_page(value: serde_json::Value) -> Result<FilePage, String> {
    let wire: WireFilePage = serde_json::from_value(value)
        .map_err(|e| format!("modworkshop file listing did not parse: {e}"))?;
    Ok(FilePage {
        data: wire.data.into_iter().map(Into::into).collect(),
        meta: wire.meta.into(),
    })
}

/// Parses a modworkshop link listing into the neutral page shape.
pub fn parse_link_page(value: serde_json::Value) -> Result<LinkPage, String> {
    let wire: WireLinkPage = serde_json::from_value(value)
        .map_err(|e| format!("modworkshop link listing did not parse: {e}"))?;
    Ok(LinkPage {
        data: wire.data.into_iter().map(Into::into).collect(),
        meta: wire.meta.into(),
    })
}

/// Parses a modworkshop listing response into the neutral page shape.
pub fn parse_mod_page(value: serde_json::Value) -> Result<ModPage, String> {
    let wire: WireModPage = serde_json::from_value(value)
        .map_err(|e| format!("modworkshop listing did not parse: {e}"))?;
    Ok(wire.into())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireImage {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    file: String,
    #[serde(rename = "type")]
    #[serde(deserialize_with = "null_default")]
    kind: String,
    #[serde(deserialize_with = "null_default")]
    size: i64,
    #[serde(deserialize_with = "null_default")]
    display_order: i64,
    #[serde(deserialize_with = "null_default")]
    visible: bool,
    #[serde(deserialize_with = "null_default")]
    has_thumb: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireTag {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    color: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireMember {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    level: String,
    #[serde(deserialize_with = "null_default")]
    accepted: bool,
    donation_url: Option<String>,
    avatar: Option<String>,
    avatar_has_thumb: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireDependency {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    mod_id: Option<i64>,
    name: Option<String>,
    url: Option<String>,
    #[serde(deserialize_with = "null_default")]
    optional: bool,
    order: Option<i64>,
    #[serde(rename = "mod")]
    target: Option<WireModSummary>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireInstructsTemplate {
    #[serde(deserialize_with = "null_default")]
    id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    instructions: String,
    #[serde(deserialize_with = "null_default")]
    dependencies: Vec<WireDependency>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireModDetail {
    #[serde(flatten)]
    summary: WireModSummary,
    version: String,
    download: Option<WireDownload>,
    changelog: Option<String>,
    instructions: Option<String>,
    license: Option<String>,
    repo_url: Option<String>,
    donation: Option<String>,
    banner: Option<WireImage>,
    #[serde(default, deserialize_with = "null_default")]
    images: Vec<WireImage>,
    #[serde(default, deserialize_with = "null_default")]
    dependencies: Vec<WireDependency>,
    instructs_template: Option<WireInstructsTemplate>,
    #[serde(default, deserialize_with = "null_default")]
    tags: Vec<WireTag>,
    #[serde(default, deserialize_with = "null_default")]
    members: Vec<WireMember>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModImage {
    pub id: i64,
    pub file: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: i64,
    pub display_order: i64,
    pub visible: bool,
    pub has_thumb: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModTag {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModMember {
    pub id: i64,
    pub name: String,
    pub level: String,
    pub accepted: bool,
    pub donation_url: Option<String>,
    pub avatar: Option<String>,
    pub avatar_has_thumb: Option<bool>,
}

/// A declared dependency. The nested mod is a SUMMARY, not a detail: modworkshop returns
/// the listing shape here, and the renderer only ever reads summary fields off it. Typing
/// it as a detail would also make this type recursive for no gain.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModDependency {
    pub id: i64,
    /// None for offsite dependencies, which are hosted outside modworkshop.
    pub mod_id: Option<i64>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub optional: bool,
    /// Author-defined install order. The renderer sorts by it, matching the mod page.
    pub order: Option<i64>,
    #[serde(rename = "mod")]
    pub target: Option<ModSummary>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct InstructsTemplate {
    pub id: i64,
    pub name: String,
    pub instructions: String,
    pub dependencies: Vec<ModDependency>,
}

/// A mod as /mods/{id} returns it: every summary field plus the ones only the detail call
/// carries. The collections are required but may be empty, so the renderer never needs an
/// empty-array fallback of its own at each use.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModDetail {
    pub id: i64,
    pub name: String,
    pub desc: String,
    pub short_desc: String,
    pub version: String,
    pub downloads: i64,
    pub likes: i64,
    pub views: i64,
    pub published_at: String,
    pub bumped_at: String,
    pub category_id: i64,
    pub has_download: bool,
    pub disable_mod_managers: Option<bool>,
    pub thumbnail: Option<ModThumbnail>,
    pub download: Option<ModDownload>,
    pub user: ModUser,
    pub changelog: Option<String>,
    pub instructions: Option<String>,
    pub license: Option<String>,
    pub repo_url: Option<String>,
    pub donation: Option<String>,
    pub banner: Option<ModImage>,
    pub images: Vec<ModImage>,
    pub dependencies: Vec<ModDependency>,
    pub instructs_template: Option<InstructsTemplate>,
    pub tags: Vec<ModTag>,
    pub members: Vec<ModMember>,
}

impl From<WireImage> for ModImage {
    fn from(w: WireImage) -> Self {
        Self {
            id: w.id,
            file: w.file,
            kind: w.kind,
            size: w.size,
            display_order: w.display_order,
            visible: w.visible,
            has_thumb: w.has_thumb,
        }
    }
}

impl From<WireTag> for ModTag {
    fn from(w: WireTag) -> Self {
        Self {
            id: w.id,
            name: w.name,
            color: w.color,
        }
    }
}

impl From<WireMember> for ModMember {
    fn from(w: WireMember) -> Self {
        Self {
            id: w.id,
            name: w.name,
            level: w.level,
            accepted: w.accepted,
            donation_url: w.donation_url,
            avatar: w.avatar,
            avatar_has_thumb: w.avatar_has_thumb,
        }
    }
}

impl From<WireDependency> for ModDependency {
    fn from(w: WireDependency) -> Self {
        Self {
            id: w.id,
            mod_id: w.mod_id,
            name: w.name,
            url: w.url,
            optional: w.optional,
            order: w.order,
            target: w.target.map(Into::into),
        }
    }
}

impl From<WireInstructsTemplate> for InstructsTemplate {
    fn from(w: WireInstructsTemplate) -> Self {
        Self {
            id: w.id,
            name: w.name,
            instructions: w.instructions,
            dependencies: w.dependencies.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<WireModDetail> for ModDetail {
    fn from(w: WireModDetail) -> Self {
        let s = ModSummary::from(w.summary);
        Self {
            id: s.id,
            name: s.name,
            desc: s.desc,
            short_desc: s.short_desc,
            version: w.version,
            downloads: s.downloads,
            likes: s.likes,
            views: s.views,
            published_at: s.published_at,
            bumped_at: s.bumped_at,
            category_id: s.category_id,
            has_download: s.has_download,
            disable_mod_managers: s.disable_mod_managers,
            thumbnail: s.thumbnail,
            download: w.download.map(Into::into),
            user: s.user,
            changelog: w.changelog,
            instructions: w.instructions,
            license: w.license,
            repo_url: w.repo_url,
            donation: w.donation,
            banner: w.banner.map(Into::into),
            images: w.images.into_iter().map(Into::into).collect(),
            dependencies: w.dependencies.into_iter().map(Into::into).collect(),
            instructs_template: w.instructs_template.map(Into::into),
            tags: w.tags.into_iter().map(Into::into).collect(),
            members: w.members.into_iter().map(Into::into).collect(),
        }
    }
}

/// Parses a modworkshop mod detail response into the neutral detail shape.
pub fn parse_mod_detail(value: serde_json::Value) -> Result<ModDetail, String> {
    let wire: WireModDetail = serde_json::from_value(value)
        .map_err(|e| format!("modworkshop mod detail did not parse: {e}"))?;
    Ok(wire.into())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireNexusNode {
    #[serde(rename = "modId")]
    #[serde(deserialize_with = "null_default")]
    mod_id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    summary: Option<String>,
    #[serde(rename = "pictureUrl")]
    picture_url: Option<String>,
    author: Option<String>,
    #[serde(deserialize_with = "null_default")]
    downloads: i64,
    #[serde(deserialize_with = "null_default")]
    endorsements: i64,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireNexusPage {
    #[serde(rename = "totalCount")]
    #[serde(deserialize_with = "null_default")]
    total_count: i64,
    #[serde(deserialize_with = "null_default")]
    nodes: Vec<WireNexusNode>,
}

/// Nexus search results, mapped onto the same summary shape modworkshop produces.
///
/// Three mappings are judgement calls rather than renames, and each loses something:
///
/// - endorsements becomes likes. Both count approval, but they are not the same metric.
/// - pictureUrl becomes thumbnail.file. modworkshop stores a CDN filename there and Nexus
///   gives a full URL. The renderer's useThumbnail passes absolute URLs through untouched,
///   which is the same route locally recorded thumbnails already take.
///
/// Version checks use Nexus detail responses, never search summaries.
fn nexus_node_to_summary(w: WireNexusNode) -> ModSummary {
    let summary = w.summary.unwrap_or_default();
    ModSummary {
        id: w.mod_id,
        name: w.name,
        desc: summary.clone(),
        short_desc: summary,
        downloads: w.downloads,
        likes: w.endorsements,
        views: 0,
        published_at: String::new(),
        bumped_at: w.updated_at.unwrap_or_default(),
        category_id: 0,
        has_download: true,
        disable_mod_managers: None,
        thumbnail: w.picture_url.map(|file| ModThumbnail {
            file,
            has_thumb: None,
        }),
        user: ModUser {
            id: None,
            name: w.author.unwrap_or_default(),
            donation_url: None,
            avatar: None,
            avatar_has_thumb: None,
        },
    }
}

/// Parses a Nexus GraphQL mods payload into the neutral page shape. Nexus pages by offset
/// rather than page number, so the caller supplies the page it asked for.
pub fn parse_nexus_page(
    value: serde_json::Value,
    page: i64,
    per_page: i64,
) -> Result<ModPage, String> {
    let wire: WireNexusPage =
        serde_json::from_value(value).map_err(|e| format!("nexus search did not parse: {e}"))?;
    let last_page = if per_page > 0 {
        (wire.total_count + per_page - 1) / per_page
    } else {
        0
    };
    Ok(ModPage {
        data: wire.nodes.into_iter().map(nexus_node_to_summary).collect(),
        meta: PageMeta {
            current_page: page,
            last_page,
            per_page,
            total: wire.total_count,
        },
    })
}

// REST v1's /mods/{id}.json, unlike the GraphQL search selection, DOES carry a real
// version field. snake_case here (not camelCase) because this is the v1 REST API, not v2
// GraphQL.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireNexusDetail {
    #[serde(deserialize_with = "null_default")]
    mod_id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    summary: Option<String>,
    description: Option<String>,
    picture_url: Option<String>,
    #[serde(deserialize_with = "null_default")]
    mod_unique_downloads: i64,
    #[serde(deserialize_with = "null_default")]
    endorsement_count: i64,
    #[serde(deserialize_with = "null_default")]
    version: String,
    created_time: Option<String>,
    updated_time: Option<String>,
    author: Option<String>,
    user: Option<WireNexusUser>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireNexusUser {
    member_id: Option<i64>,
}

/// Parses a Nexus mod-detail response into the neutral detail shape. Nexus has no
/// equivalent of modworkshop's images, dependencies, tags, members, changelog or license,
/// so those come back empty or None and ModDetailPage's tabs hide themselves, degrading to
/// a smaller but still correct page. desc is Nexus BBCode, parsed by NexusDescription.
pub fn parse_nexus_detail(value: serde_json::Value) -> Result<ModDetail, String> {
    let w: WireNexusDetail = serde_json::from_value(value)
        .map_err(|e| format!("nexus mod detail did not parse: {e}"))?;
    let short_desc = w.summary.unwrap_or_default();
    Ok(ModDetail {
        id: w.mod_id,
        name: w.name,
        desc: w.description.unwrap_or_else(|| short_desc.clone()),
        short_desc,
        version: w.version,
        downloads: w.mod_unique_downloads,
        likes: w.endorsement_count,
        views: 0,
        published_at: w.created_time.unwrap_or_default(),
        bumped_at: w.updated_time.unwrap_or_default(),
        category_id: 0,
        has_download: true,
        disable_mod_managers: None,
        thumbnail: w.picture_url.map(|file| ModThumbnail {
            file,
            has_thumb: None,
        }),
        download: None,
        user: ModUser {
            id: w.user.and_then(|u| u.member_id),
            name: w.author.unwrap_or_default(),
            donation_url: None,
            avatar: None,
            avatar_has_thumb: None,
        },
        changelog: None,
        instructions: None,
        license: None,
        repo_url: None,
        donation: None,
        banner: None,
        images: Vec::new(),
        dependencies: Vec::new(),
        instructs_template: None,
        tags: Vec::new(),
        members: Vec::new(),
    })
}

// REST v1's own IFileInfo shape (node-nexus-api's official client), verified against
// its published .d.ts: file_id, name, version, mod_version, size_kb, category_name,
// description, file_name, uploaded_time. size is redundant with size_kb on the wire and
// is not modelled here.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireNexusFile {
    #[serde(deserialize_with = "null_default")]
    file_id: i64,
    #[serde(deserialize_with = "null_default")]
    name: String,
    #[serde(deserialize_with = "null_default")]
    version: String,
    #[serde(deserialize_with = "null_default")]
    mod_version: String,
    #[serde(deserialize_with = "null_default")]
    size_kb: i64,
    category_name: Option<String>,
    description: Option<String>,
    #[serde(deserialize_with = "null_default")]
    file_name: String,
    uploaded_time: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct WireNexusFiles {
    #[serde(deserialize_with = "null_default")]
    files: Vec<WireNexusFile>,
}

fn nexus_file_to_mod_file(w: WireNexusFile, domain: &str, mod_id: u32) -> ModFile {
    let kind = std::path::Path::new(&w.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase);
    ModFile {
        id: w.file_id,
        name: if w.name.is_empty() {
            w.file_name
        } else {
            w.name
        },
        version: if w.version.is_empty() {
            w.mod_version
        } else {
            w.version
        },
        size: w.size_kb.saturating_mul(1024),
        kind,
        download_url: String::new(),
        // nmm=1 is Nexus's own mod-manager-download deep link param (verified against
        // Vortex's own source, which opens exactly this URL shape to resolve a free-tier
        // download): with a file_id present it auto-triggers that file's "Mod Manager
        // Download" action on page load, skipping the extra click of finding the button.
        url: Some(format!(
            "https://www.nexusmods.com/{domain}/mods/{mod_id}?tab=files&file_id={}&nmm=1",
            w.file_id
        )),
        image_id: None,
        desc: w.description.filter(|d| !d.is_empty()),
        label: w.category_name,
        downloads: None,
        created_at: w.uploaded_time,
    }
}

/// Parses a Nexus mod's file listing into the neutral file-page shape. Nexus files carry no
/// direct download URL for a free account (only Premium or a real nxm:// handoff from the
/// site produces one), so download_url stays empty and url deep-links to the file's tab on
/// the mod's Nexus page, the same fallback DownloadsTab shows when no files are known.
pub fn parse_nexus_files(
    value: serde_json::Value,
    domain: &str,
    mod_id: u32,
) -> Result<FilePage, String> {
    let wire: WireNexusFiles = serde_json::from_value(value)
        .map_err(|e| format!("nexus file listing did not parse: {e}"))?;
    let data: Vec<ModFile> = wire
        .files
        .into_iter()
        .map(|f| nexus_file_to_mod_file(f, domain, mod_id))
        .collect();
    let total = data.len() as i64;
    Ok(FilePage {
        data,
        meta: PageMeta {
            current_page: 1,
            last_page: 1,
            per_page: total,
            total,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> ModPage {
        parse_mod_page(serde_json::from_str(json).expect("json")).expect("page")
    }

    // The listing shape as modworkshop actually returns it, trimmed to the fields the
    // renderer reads. Guards the field names, which are the whole contract.
    const LIST_JSON: &str = r#"{
        "data": [{
            "id": 58065,
            "name": "Test Mod",
            "desc": "long",
            "short_desc": "short",
            "downloads": 100,
            "likes": 5,
            "views": 900,
            "published_at": "2024-01-01",
            "bumped_at": "2024-02-01",
            "category_id": 7,
            "has_download": true,
            "thumbnail": { "file": "abc.png", "has_thumb": true },
            "user": { "id": 3, "name": "Author" }
        }],
        "meta": { "current_page": 1, "last_page": 4, "per_page": 24, "total": 90 }
    }"#;

    #[test]
    fn parses_a_real_listing_shape() {
        let page = parse(LIST_JSON);
        assert_eq!(page.meta.last_page, 4);
        assert_eq!(page.meta.total, 90);
        let m = &page.data[0];
        assert_eq!(m.id, 58065);
        assert_eq!(m.thumbnail.as_ref().expect("thumbnail").file, "abc.png");
        let serialized = serde_json::to_value(m).unwrap();
        assert!(serialized.get("version").is_none());
        assert!(serialized.get("download").is_none());
        assert_eq!(m.user.name, "Author");
    }

    // An external-link mod: download carries url and none of download_url/type/size.
    // Modelling those as required would error the entire page over one such mod.
    #[test]
    fn parses_a_link_type_download() {
        let detail = parse_mod_detail(serde_json::json!({"id":1,"name":"L", "version":"1", "download":{"id":9,"version":"1","url":"https://example.test/page"}})).unwrap();
        let d = detail.download.as_ref().expect("download");
        assert_eq!(d.url.as_deref(), Some("https://example.test/page"));
        assert!(d.download_url.is_none());
        assert!(d.kind.is_none());
        assert!(d.size.is_none());
    }

    // The failure mode this whole module is defensive about: a mod missing fields the old
    // untyped path rendered as blank must not take the entire request down with it.
    #[test]
    fn a_mod_missing_optional_fields_still_parses() {
        let page = parse(r#"{"data":[{"id":2,"name":"Bare"}],"meta":{}}"#);
        let m = &page.data[0];
        assert_eq!(m.name, "Bare");
        assert!(!m.has_download);
        assert!(m.thumbnail.is_none());
        assert_eq!(m.user.name, "");
    }

    #[test]
    fn an_empty_page_parses() {
        let page = parse(r#"{"data":[],"meta":{}}"#);
        assert!(page.data.is_empty());
        assert_eq!(page.meta.total, 0);
    }

    // Unmodelled fields are dropped rather than rejected, so modworkshop adding a field
    // never breaks a shipped build.
    #[test]
    fn unknown_fields_are_ignored() {
        let page = parse(r#"{"data":[{"id":3,"name":"X","brand_new_field":{"a":1}}],"meta":{}}"#);
        assert_eq!(page.data[0].id, 3);
    }

    // A hosted file carries download_url/type/size. The renderer picks install behaviour
    // from type, so it must survive as null rather than becoming an empty string.
    #[test]
    fn parses_a_file_listing() {
        let page = parse_file_page(
            serde_json::from_str(
                r#"{"data":[{"id":7,"name":"main.zip","version":"1.2","size":99,
                "type":"zip","download_url":"https://example.test/f.zip"}],"meta":{"total":1}}"#,
            )
            .expect("json"),
        )
        .expect("page");
        let f = &page.data[0];
        assert_eq!(f.id, 7);
        assert_eq!(f.kind.as_deref(), Some("zip"));
        assert_eq!(f.download_url, "https://example.test/f.zip");
        assert!(f.desc.is_none());
        assert_eq!(page.meta.total, 1);
    }

    // Files with no type are real: the renderer falls back to the URL extension.
    #[test]
    fn a_file_without_a_type_still_parses() {
        let page = parse_file_page(
            serde_json::from_str(r#"{"data":[{"id":8,"download_url":"u"}],"meta":{}}"#)
                .expect("json"),
        )
        .expect("page");
        assert!(page.data[0].kind.is_none());
        assert_eq!(page.data[0].version, "");
    }

    #[test]
    fn parses_a_link_listing() {
        let page = parse_link_page(
            serde_json::from_str(
                r#"{"data":[{"id":3,"name":"Mirror","url":"https://example.test"}],"meta":{}}"#,
            )
            .expect("json"),
        )
        .expect("page");
        assert_eq!(page.data[0].name, "Mirror");
        assert_eq!(page.data[0].url, "https://example.test");
        assert!(page.data[0].version.is_none());
    }

    // serde(flatten) is what lets the detail response reuse the summary wire struct. If it
    // ever stops merging, the summary half silently comes back as defaults, so this asserts
    // both halves land from one payload.
    #[test]
    fn detail_carries_both_summary_and_detail_fields() {
        let detail = parse_mod_detail(
            serde_json::from_str(
                r##"{"id":42,"name":"Full Mod","version":"3.0","has_download":true,
                "user":{"id":8,"name":"Author"},
                "changelog":"notes","license":"MIT","repo_url":"https://example.test/r",
                "images":[{"id":1,"file":"a.png","type":"image/png","visible":true}],
                "tags":[{"id":5,"name":"Weapons","color":"#fff"}],
                "members":[{"id":2,"name":"Helper","level":"contributor","accepted":true}]}"##,
            )
            .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.id, 42, "summary half must survive the flatten");
        assert_eq!(detail.version, "3.0");
        assert_eq!(detail.user.name, "Author");
        assert_eq!(detail.changelog.as_deref(), Some("notes"));
        assert_eq!(detail.images.len(), 1);
        assert_eq!(detail.images[0].kind, "image/png");
        assert_eq!(detail.tags[0].name, "Weapons");
        assert_eq!(detail.members[0].level, "contributor");
    }

    // A dependency nests the LISTING shape under "mod", and offsite dependencies have no
    // mod at all. Both must survive, since the deps tab keys off exactly this.
    #[test]
    fn dependencies_keep_their_nested_summary_and_offsite_form() {
        let detail = parse_mod_detail(
            serde_json::from_str(
                r#"{"id":1,"name":"M","version":"","dependencies":[
                {"id":10,"mod_id":55,"optional":false,"order":1,
                 "mod":{"id":55,"name":"Required Dep","version":"1.1"}},
                {"id":11,"mod_id":null,"optional":true,"name":"SuperBLT",
                 "url":"https://superblt.znix.xyz"}]}"#,
            )
            .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.dependencies.len(), 2);
        let hosted = &detail.dependencies[0];
        assert_eq!(hosted.mod_id, Some(55));
        assert_eq!(
            hosted.target.as_ref().expect("nested mod").name,
            "Required Dep"
        );
        let offsite = &detail.dependencies[1];
        assert!(offsite.mod_id.is_none());
        assert!(offsite.target.is_none());
        assert_eq!(offsite.url.as_deref(), Some("https://superblt.znix.xyz"));
    }

    // Collections are required on the public type, so a response omitting them entirely
    // must normalize to empty rather than failing or producing null.
    #[test]
    fn a_detail_without_collections_normalizes_to_empty() {
        let detail = parse_mod_detail(
            serde_json::from_str(r#"{"id":2,"name":"Bare","version":""}"#).expect("json"),
        )
        .expect("detail");
        assert!(detail.images.is_empty());
        assert!(detail.dependencies.is_empty());
        assert!(detail.tags.is_empty());
        assert!(detail.members.is_empty());
        assert!(detail.banner.is_none());
        assert!(detail.instructs_template.is_none());
    }

    #[test]
    fn instructs_template_dependencies_parse() {
        let detail = parse_mod_detail(
            serde_json::from_str(
                r#"{"id":3,"name":"T","version":"","instructs_template":{"id":9,"name":"BLT",
                "instructions":"do this","dependencies":[{"id":12,"mod_id":49744,"optional":false}]}}"#,
            )
            .expect("json"),
        )
        .expect("detail");
        let tpl = detail.instructs_template.as_ref().expect("template");
        assert_eq!(tpl.instructions, "do this");
        assert_eq!(tpl.dependencies[0].mod_id, Some(49744));
    }

    #[test]
    fn nexus_nodes_map_onto_the_shared_summary_shape() {
        let page = parse_nexus_page(
            serde_json::from_str(
                r#"{"totalCount":50,"nodes":[{"modId":900,"name":"Nexus Mod",
                "summary":"does things","pictureUrl":"https://cdn.nexus.test/a.png",
                "author":"Someone","downloads":12,"endorsements":3,
                "updatedAt":"2026-01-01"}]}"#,
            )
            .expect("json"),
            2,
            24,
        )
        .expect("page");
        let m = &page.data[0];
        assert_eq!(m.id, 900);
        assert_eq!(m.user.name, "Someone");
        assert_eq!(m.likes, 3, "endorsements stand in for likes");
        assert_eq!(m.bumped_at, "2026-01-01");
        assert_eq!(
            m.thumbnail.as_ref().expect("thumbnail").file,
            "https://cdn.nexus.test/a.png",
            "an absolute URL rides the thumbnail field, as locally recorded ones already do"
        );
        assert!(m.has_download);
    }

    #[test]
    fn nexus_paging_converts_offset_totals_into_page_counts() {
        let page = parse_nexus_page(
            serde_json::from_str(r#"{"totalCount":50,"nodes":[]}"#).expect("json"),
            2,
            24,
        )
        .expect("page");
        assert_eq!(page.meta.current_page, 2);
        assert_eq!(page.meta.total, 50);
        assert_eq!(page.meta.last_page, 3, "50 over 24 rounds up to 3 pages");
    }

    #[test]
    fn a_nexus_node_missing_optional_fields_still_parses() {
        let page = parse_nexus_page(
            serde_json::from_str(r#"{"totalCount":1,"nodes":[{"modId":5,"name":"Bare"}]}"#)
                .expect("json"),
            1,
            24,
        )
        .expect("page");
        let m = &page.data[0];
        assert_eq!(m.name, "Bare");
        assert_eq!(m.user.name, "");
        assert!(m.thumbnail.is_none());
    }

    // Reported live: a listing came back with an explicit null where a number was
    // expected and the whole page failed with "invalid type: null, expected i64".
    // serde(default) does not cover this: it fires for an ABSENT field, not a present
    // null. Every non-Option wire field carries null_default for exactly this.
    #[test]
    fn explicit_nulls_fall_back_to_defaults_instead_of_failing() {
        let page = parse(
            r#"{"data":[{"id":1,"name":"Nulls","category_id":null,"downloads":null,
            "likes":null,"views":null,"version":null,"desc":null,"short_desc":null,
            "published_at":null,"bumped_at":null,"has_download":null,
            "thumbnail":null,"download":null,"user":null}],
            "meta":{"current_page":null,"last_page":null,"per_page":null,"total":null}}"#,
        );
        let m = &page.data[0];
        assert_eq!(m.id, 1);
        assert_eq!(m.category_id, 0);
        assert_eq!(m.downloads, 0);
        assert!(!m.has_download);
        assert_eq!(
            m.user.name, "",
            "a null object must not fail the whole page either"
        );
        assert_eq!(page.meta.total, 0);
    }

    #[test]
    fn explicit_nulls_in_file_and_link_listings_are_tolerated() {
        let files = parse_file_page(
            serde_json::from_str(
                r#"{"data":[{"id":1,"name":null,"version":null,"size":null,
                "download_url":null}],"meta":null}"#,
            )
            .expect("json"),
        )
        .expect("files");
        assert_eq!(files.data[0].size, 0);
        assert_eq!(files.data[0].download_url, "");

        let links = parse_link_page(
            serde_json::from_str(r#"{"data":[{"id":2,"name":null,"url":null}],"meta":null}"#)
                .expect("json"),
        )
        .expect("links");
        assert_eq!(links.data[0].url, "");
    }

    #[test]
    fn explicit_nulls_in_a_mod_detail_are_tolerated() {
        let detail = parse_mod_detail(
            serde_json::from_str(
                r#"{"id":3,"name":"D","version":"","category_id":null,"images":null,
                "dependencies":null,"tags":null,"members":null,"banner":null}"#,
            )
            .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.category_id, 0);
        assert!(
            detail.images.is_empty(),
            "a null collection must read as empty"
        );
        assert!(detail.tags.is_empty());
    }

    #[test]
    fn explicit_nulls_in_a_nexus_node_are_tolerated() {
        let page = parse_nexus_page(
            serde_json::from_str(
                r#"{"totalCount":null,"nodes":[{"modId":9,"name":null,"downloads":null,
                "endorsements":null,"summary":null,"author":null}]}"#,
            )
            .expect("json"),
            1,
            24,
        )
        .expect("page");
        assert_eq!(page.data[0].id, 9);
        assert_eq!(page.data[0].downloads, 0);
        assert_eq!(page.meta.total, 0);
    }

    #[test]
    fn nexus_detail_carries_a_real_version_and_empty_modworkshop_only_fields() {
        let detail = parse_nexus_detail(
            serde_json::from_str(
                r#"{"mod_id":900,"name":"Nexus Mod","summary":"short","description":"long",
                "picture_url":"https://cdn.nexus.test/a.png","mod_unique_downloads":12,
                "endorsement_count":3,"version":"1.2.0","created_time":"2026-01-01",
                "updated_time":"2026-02-01","author":"Someone"}"#,
            )
            .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.id, 900);
        assert_eq!(detail.version, "1.2.0");
        assert_eq!(detail.desc, "long");
        assert_eq!(detail.short_desc, "short");
        assert_eq!(detail.downloads, 12);
        assert_eq!(detail.likes, 3);
        assert!(detail.images.is_empty());
        assert!(detail.dependencies.is_empty());
        assert!(detail.tags.is_empty());
        assert!(detail.changelog.is_none());
    }

    #[test]
    fn nexus_detail_carries_the_uploader_member_id() {
        let detail = parse_nexus_detail(
            serde_json::from_str(
                r#"{"mod_id":52,"name":"RinoHud","author":"Abkarino",
                "uploaded_by":"abkarino",
                "uploaded_users_profile_url":"https://www.nexusmods.com/users/170994828",
                "user":{"member_id":170994828,"member_group_id":27,"name":"abkarino"}}"#,
            )
            .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.user.id, Some(170994828));
        assert_eq!(detail.user.name, "Abkarino");
    }

    #[test]
    fn a_nexus_detail_missing_description_falls_back_to_summary() {
        let detail = parse_nexus_detail(
            serde_json::from_str(r#"{"mod_id":1,"name":"N","summary":"short only"}"#)
                .expect("json"),
        )
        .expect("detail");
        assert_eq!(detail.desc, "short only");
        assert_eq!(detail.short_desc, "short only");
    }

    #[test]
    fn parses_a_real_nexus_file_listing_shape() {
        let page = parse_nexus_files(
            serde_json::from_str(
                r#"{"files":[{"file_id":789,"name":"Main File","version":"1.2.0",
                "mod_version":"1.2.0","category_name":"MAIN","size_kb":512,
                "description":"the main archive","file_name":"CoolMod-789-1-2-0.zip",
                "uploaded_time":"2026-01-01T00:00:00.000+00:00"}],
                "file_updates":[]}"#,
            )
            .expect("json"),
            "payday3",
            900,
        )
        .expect("page");
        let f = &page.data[0];
        assert_eq!(f.id, 789);
        assert_eq!(f.name, "Main File");
        assert_eq!(f.version, "1.2.0");
        assert_eq!(f.size, 512 * 1024);
        assert_eq!(f.kind.as_deref(), Some("zip"));
        assert_eq!(f.label.as_deref(), Some("MAIN"));
        assert_eq!(f.download_url, "", "no direct URL without an nxm handoff");
        assert_eq!(
            f.url.as_deref(),
            Some("https://www.nexusmods.com/payday3/mods/900?tab=files&file_id=789&nmm=1")
        );
        assert_eq!(page.meta.total, 1);
    }

    // A file with no display name or per-file version is real (mods that only fill in
    // the mod-level version). Both must fall back rather than surface as blank.
    #[test]
    fn a_nexus_file_without_a_name_or_version_falls_back() {
        let page = parse_nexus_files(
            serde_json::from_str(
                r#"{"files":[{"file_id":1,"mod_version":"2.0","file_name":"mod.7z"}]}"#,
            )
            .expect("json"),
            "crimebossrockaycity",
            5,
        )
        .expect("page");
        let f = &page.data[0];
        assert_eq!(f.name, "mod.7z");
        assert_eq!(f.version, "2.0");
        assert_eq!(f.kind.as_deref(), Some("7z"));
    }

    #[test]
    fn an_empty_nexus_description_is_treated_as_absent() {
        let page = parse_nexus_files(
            serde_json::from_str(r#"{"files":[{"file_id":1,"description":""}]}"#).expect("json"),
            "payday3",
            1,
        )
        .expect("page");
        assert!(page.data[0].desc.is_none());
    }
}

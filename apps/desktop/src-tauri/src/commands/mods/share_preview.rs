use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;
use specta::Type;

use super::{ProfileShare, ShareFile, ShareMember};
use crate::commands::domain::ModFile;
use crate::commands::launchers::identify_launcher_for_path;
use crate::commands::loaders::{is_loader_installed, loader_spec};
use crate::commands::mods::{profiles::ProfileStore, ModEngineConfig};
use crate::commands::settings::{game_settings, read_settings};

#[path = "share_fetch.rs"]
mod fetch;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewFile {
    pub(super) id: u32,
    pub(super) name: String,
    pub(super) label: Option<String>,
    pub(super) version: Option<String>,
    size: Option<u64>,
}

impl TryFrom<ModFile> for PreviewFile {
    type Error = String;

    fn try_from(file: ModFile) -> Result<Self, String> {
        let id = u32::try_from(file.id)
            .ok()
            .filter(|id| *id > 0)
            .ok_or("Invalid catalog file ID")?;
        Ok(Self {
            id,
            name: file.name,
            label: file.label.filter(|s| !s.is_empty()),
            version: (!file.version.is_empty()).then_some(file.version),
            size: u64::try_from(file.size).ok().filter(|size| *size > 0),
        })
    }
}

#[derive(Debug, Clone)]
enum LookupIssue {
    Unavailable(String),
    Failed(String),
    NexusSignInRequired,
}

type Files = Result<Vec<PreviewFile>, LookupIssue>;

#[derive(Default)]
struct Catalog {
    workshop: HashMap<u32, Files>,
    // Mod page versions. A Workshop record stores this one, never the version of a file.
    workshop_versions: HashMap<u32, String>,
    nexus_pins: HashMap<(u32, u32), Result<Option<PreviewFile>, LookupIssue>>,
    nexus_choices: HashMap<u32, Files>,
}

#[derive(Debug, Serialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum ShareResolution {
    Ready {
        file: PreviewFile,
        found_by_name: bool,
    },
    NexusDownload {
        file: PreviewFile,
    },
    NeedsChoice {
        candidates: Vec<PreviewFile>,
    },
    Unavailable {
        reason: String,
    },
    LookupFailed {
        reason: String,
    },
    NexusSignInRequired,
}

impl From<&LookupIssue> for ShareResolution {
    fn from(issue: &LookupIssue) -> Self {
        match issue {
            LookupIssue::Unavailable(reason) => Self::Unavailable {
                reason: reason.clone(),
            },
            LookupIssue::Failed(reason) => Self::LookupFailed {
                reason: reason.clone(),
            },
            LookupIssue::NexusSignInRequired => Self::NexusSignInRequired,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(super) enum ShareSource {
    ModWorkshop,
    Nexus,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharePreviewRow {
    pub(super) member_key: usize,
    source: ShareSource,
    mod_id: u32,
    installed_name: String,
    pub(super) shared_version: Option<String>,
    pub(super) install_version: Option<String>,
    pub(super) resolution: ShareResolution,
}

#[derive(Debug, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct SharePreviewTotals {
    ready: usize,
    nexus_download: usize,
    needs_choice: usize,
    unavailable: usize,
    lookup_failed: usize,
    nexus_sign_in_required: usize,
    known_download_bytes: u64,
    nexus_downloads_needed: usize,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharePreviewLoader {
    id: String,
    name: &'static str,
    already_present: bool,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSharePreview {
    profile_name: String,
    pub(super) rows: Vec<SharePreviewRow>,
    loaders: Vec<SharePreviewLoader>,
    totals: SharePreviewTotals,
    failed_sources: Vec<ShareSource>,
}

fn unique_file(
    files: &[PreviewFile],
    matches: impl Fn(&PreviewFile) -> bool,
) -> Option<&PreviewFile> {
    let mut matches = files.iter().filter(|f| matches(f));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn workshop_resolution(
    files: &[PreviewFile],
    file_id: Option<u32>,
    file_name: Option<&str>,
    label: Option<&str>,
    installed_name: &str,
    extension: Option<&str>,
) -> ShareResolution {
    if files.is_empty() {
        return ShareResolution::Unavailable {
            reason: "This mod has no files to download".into(),
        };
    }
    let ready = |file: &PreviewFile, found_by_name| ShareResolution::Ready {
        file: file.clone(),
        found_by_name,
    };
    if let Some(id) = file_id {
        if let Some(file) = files.iter().find(|f| f.id == id) {
            return ready(file, false);
        }
        let by_name =
            file_name.and_then(|name| unique_file(files, |f| f.name.eq_ignore_ascii_case(name)));
        let by_label = || {
            label.and_then(|label| {
                unique_file(files, |f| {
                    f.label
                        .as_ref()
                        .is_some_and(|s| s.eq_ignore_ascii_case(label))
                })
            })
        };
        if let Some(file) = by_name.or_else(by_label) {
            return ready(file, true);
        }
    } else if let [only] = files {
        return ready(only, false);
    }
    // Workshop publishes file names without the archive extension. A file target adds its
    // game extension to the installed name, which a directory target can legitimately contain.
    let stem = installed_name
        .rsplit_once('.')
        .filter(|(_, ext)| extension.is_some_and(|e| ext.eq_ignore_ascii_case(e)));
    let matched = unique_file(files, |f| {
        f.name.eq_ignore_ascii_case(installed_name)
            || stem.is_some_and(|(stem, _)| f.name.eq_ignore_ascii_case(stem))
    });
    match matched {
        Some(file) => ready(file, true),
        None => ShareResolution::NeedsChoice {
            candidates: files.to_vec(),
        },
    }
}

fn nexus_resolution(catalog: &Catalog, mod_id: u32, file_id: Option<u32>) -> ShareResolution {
    if let Some(id) = file_id {
        match &catalog.nexus_pins[&(mod_id, id)] {
            Ok(Some(file)) => return ShareResolution::NexusDownload { file: file.clone() },
            Err(issue) => return issue.into(),
            Ok(None) => {}
        }
    }
    match &catalog.nexus_choices[&mod_id] {
        Ok(files) if files.is_empty() => ShareResolution::Unavailable {
            reason: "The Nexus mod has no files to choose from".into(),
        },
        Ok(files) => ShareResolution::NeedsChoice {
            candidates: files.clone(),
        },
        Err(issue) => issue.into(),
    }
}

impl ShareResolution {
    fn file(&self) -> Option<&PreviewFile> {
        match self {
            Self::Ready { file, .. } | Self::NexusDownload { file } => Some(file),
            _ => None,
        }
    }
}

fn resolve_member(
    member: &ShareMember,
    cfg: &ModEngineConfig,
    catalog: &Catalog,
    member_key: usize,
) -> SharePreviewRow {
    let (source, mod_id, shared_version, install_version, resolution) = match &member.file {
        ShareFile::ModWorkshop {
            mod_id,
            file_id,
            file_name,
            label,
            version,
        } => {
            let status = match &catalog.workshop[mod_id] {
                Ok(files) => workshop_resolution(
                    files,
                    *file_id,
                    file_name.as_deref(),
                    label.as_deref(),
                    &member.installed_name,
                    cfg.target_for(member.target.as_deref()).content_extension(),
                ),
                Err(issue) => issue.into(),
            };
            let installs = status
                .file()
                .and_then(|_| catalog.workshop_versions.get(mod_id).cloned());
            (
                ShareSource::ModWorkshop,
                *mod_id,
                version.clone(),
                installs,
                status,
            )
        }
        ShareFile::Nexus { mod_id, file_id } => {
            let status = nexus_resolution(catalog, *mod_id, *file_id);
            let shared = status.file().and_then(|f| f.version.clone());
            (ShareSource::Nexus, *mod_id, shared.clone(), shared, status)
        }
    };
    SharePreviewRow {
        member_key,
        source,
        mod_id,
        installed_name: member.installed_name.clone(),
        shared_version,
        install_version,
        resolution,
    }
}

fn resolve(
    share: &ProfileShare,
    cfg: &ModEngineConfig,
    catalog: &Catalog,
    loaders: Vec<SharePreviewLoader>,
) -> ProfileSharePreview {
    let rows: Vec<_> = share
        .members
        .iter()
        .enumerate()
        .map(|(i, m)| resolve_member(m, cfg, catalog, i + 1))
        .collect();
    let mut totals = SharePreviewTotals::default();
    let mut downloads = HashSet::new();
    for row in &rows {
        match &row.resolution {
            ShareResolution::Ready { .. } => totals.ready += 1,
            ShareResolution::NexusDownload { .. } => totals.nexus_download += 1,
            ShareResolution::NeedsChoice { .. } => totals.needs_choice += 1,
            ShareResolution::Unavailable { .. } => totals.unavailable += 1,
            ShareResolution::LookupFailed { .. } => totals.lookup_failed += 1,
            ShareResolution::NexusSignInRequired => totals.nexus_sign_in_required += 1,
        }
        let Some(file) = row.resolution.file() else {
            continue;
        };
        if downloads.insert((row.source, row.mod_id, file.id)) {
            totals.known_download_bytes += file.size.unwrap_or(0);
            totals.nexus_downloads_needed += usize::from(row.source == ShareSource::Nexus);
        }
    }
    let failed_sources = [ShareSource::ModWorkshop, ShareSource::Nexus]
        .into_iter()
        .filter(|source| {
            let mut from_source = rows.iter().filter(|row| row.source == *source).peekable();
            from_source.peek().is_some()
                && from_source
                    .all(|row| matches!(row.resolution, ShareResolution::LookupFailed { .. }))
        })
        .collect();
    ProfileSharePreview {
        profile_name: share.profile_name.clone(),
        rows,
        loaders,
        totals,
        failed_sources,
    }
}

fn preview_loaders(
    share: &ProfileShare,
    game_path: &str,
    launcher: Option<&str>,
) -> Result<Vec<SharePreviewLoader>, String> {
    let store = ProfileStore::new(game_path);
    share
        .loaders
        .iter()
        .flatten()
        .map(|id| {
            let spec = loader_spec(id).expect("the share parser checked the loose loader");
            let already_present = is_loader_installed(spec, &share.game_id, game_path, launcher)
                || store.has_parked_loader(id)?;
            Ok(SharePreviewLoader {
                id: id.clone(),
                name: spec.name,
                already_present,
            })
        })
        .collect()
}

pub(in crate::commands::mods) async fn from_text<T>(
    input: String,
    game_id: String,
    preview: impl AsyncFnOnce(ProfileShare) -> Result<T, String>,
) -> Result<T, String> {
    let share = crate::commands::mods::parse_profile_share(input).await?;
    if share.game_id != game_id {
        return Err(format!(
            "This profile is for {}, but the target game is {game_id}",
            share.game_id
        ));
    }
    preview(share).await
}

pub(in crate::commands::mods) async fn for_install(
    app: tauri::AppHandle,
    share: ProfileShare,
    game_path: String,
) -> Result<ProfileSharePreview, String> {
    let worker_app = app.clone();
    let (share, cfg, loaders) = tauri::async_runtime::spawn_blocking(move || {
        let cfg = super::engine_for_game(&share.game_id)?;
        let target = Path::new(&game_path);
        if !target.is_dir() {
            return Err("The target game folder could not be opened".into());
        }
        let settings = read_settings(&worker_app);
        let launcher = game_settings(&settings, &share.game_id)
            .filter(|g| g.game_path.as_deref().map(Path::new) == Some(target))
            .and_then(|g| g.launcher.clone())
            .unwrap_or_else(|| identify_launcher_for_path(&game_path));
        let loaders = preview_loaders(&share, &game_path, Some(&launcher))?;
        Ok::<_, String>((share, cfg, loaders))
    })
    .await
    .map_err(|e| format!("Profile preview worker failed: {e}"))??;
    let catalog = fetch::catalog(&app, &share).await;
    Ok(resolve(&share, cfg, &catalog, loaders))
}

#[cfg(test)]
#[path = "share_preview_tests.rs"]
mod tests;

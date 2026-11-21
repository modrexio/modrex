use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use super::preview::{self, ProfileSharePreview, ShareResolution};
use super::{ProfileShare, ShareChild, ShareFile, ShareMember};
use crate::commands::loaders::{self, InstallStrategy};
use crate::commands::mods::{
    self,
    profiles::{self, Install, ProfileStore},
};

#[path = "share_replay.rs"]
mod replay;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::commands::mods) struct PendingReference {
    game_id: String,
    install_id: String,
    member_key: usize,
    member: ShareMember,
    file_id: Option<u32>,
    folder_id: Option<String>,
    priority: Option<i64>,
    reason: String,
    // Set when the import stopped at a question only the normal install flow can ask, such
    // as which archive entry or add-on to install.
    #[serde(default)]
    needs_install_flow: bool,
}

impl PendingReference {
    /// The same waiting mod for a copied profile, under an install id of its own, since no two
    /// profiles share an installation.
    pub(in crate::commands::mods) fn reissued(&self) -> Self {
        Self {
            install_id: uuid::Uuid::new_v4().to_string(),
            ..self.clone()
        }
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MemberOutcome {
    Installed { install_id: String },
    Pending { reason: String },
    Failed { error: String },
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportMemberResult {
    member_key: usize,
    outcome: MemberOutcome,
}

#[derive(Debug, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
enum LoaderOutcome {
    AlreadyPresent,
    ViaModFlow,
    Installed,
    Failed { error: String },
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportResult {
    profile_id: String,
    members: Vec<ImportMemberResult>,
    loaders: BTreeMap<String, LoaderOutcome>,
    newer_versions: usize,
}

pub(super) struct ImportRow {
    pending: PendingReference,
    workshop: Option<(u32, u32)>,
    newer: bool,
    lookup_failed: bool,
}

fn newer_version(current: Option<&str>, shared: Option<&str>) -> bool {
    fn numeric(s: &str) -> Option<Vec<u64>> {
        let s = s.trim().trim_start_matches(['v', 'V']);
        let mut parts = s
            .split('.')
            .map(str::parse)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        while parts.last() == Some(&0) {
            parts.pop();
        }
        Some(parts)
    }
    let Some((current, shared)) = current.zip(shared) else {
        return false;
    };
    match (numeric(current), numeric(shared)) {
        (Some(a), Some(b)) => a > b,
        _ => current != shared,
    }
}

pub(super) fn resolve_rows(
    share: &ProfileShare,
    preview: ProfileSharePreview,
    mut choices: BTreeMap<String, u32>,
) -> Result<Vec<ImportRow>, String> {
    let mut rows = Vec::with_capacity(share.members.len());
    for (row, member) in preview.rows.into_iter().zip(&share.members) {
        let choice = choices.remove(&row.member_key.to_string());
        let lookup_failed = matches!(row.resolution, ShareResolution::LookupFailed { .. });
        let (file, reason) = match (row.resolution, choice) {
            (ShareResolution::NeedsChoice { candidates }, Some(id)) => {
                let file = candidates.into_iter().find(|f| f.id == id).ok_or_else(|| {
                    format!("File {id} is not a candidate for member {}", row.member_key)
                })?;
                (Some(file), None)
            }
            (_, Some(_)) => {
                return Err(format!(
                    "Member {} does not need a file choice",
                    row.member_key
                ))
            }
            (
                ShareResolution::Ready { file, .. } | ShareResolution::NexusDownload { file },
                None,
            ) => (Some(file), None),
            (ShareResolution::NeedsChoice { .. }, None) => (None, Some("Choose a file".into())),
            (
                ShareResolution::Unavailable { reason } | ShareResolution::LookupFailed { reason },
                None,
            ) => (None, Some(reason)),
            (ShareResolution::NexusSignInRequired, None) => {
                (None, Some("Sign in to Nexus to download this file".into()))
            }
        };
        let newer = newer_version(
            row.install_version.as_deref(),
            row.shared_version.as_deref(),
        );
        let file_id = file.map(|f| f.id);
        let (workshop, pin, waiting) = match member.file {
            // A ModWorkshop file that did not resolve is gone, so the entry waits for a choice.
            ShareFile::ModWorkshop { mod_id, .. } => (
                file_id.map(|id| (mod_id, id)),
                None,
                "The import stopped before this mod was installed",
            ),
            ShareFile::Nexus { file_id: pin, .. } => (None, pin, "Waiting for a Nexus download"),
        };
        rows.push(ImportRow {
            pending: PendingReference {
                game_id: share.game_id.clone(),
                install_id: uuid::Uuid::new_v4().to_string(),
                member_key: row.member_key,
                member: member.clone(),
                file_id: file_id.or(pin),
                folder_id: None,
                priority: member.priority,
                reason: reason.unwrap_or_else(|| waiting.into()),
                needs_install_flow: false,
            },
            workshop,
            newer,
            lookup_failed,
        });
    }
    if !choices.is_empty() {
        return Err("A file choice names an unknown profile member".into());
    }
    Ok(rows)
}

fn disk_name(name: &str) -> Result<(), String> {
    super::basename(name)?;
    crate::commands::launchers::native_paths::normalize_native_path(name).map(|_| ())
}

fn plan_folders(
    share: &ProfileShare,
    install: &Install,
    rows: &mut [ImportRow],
) -> Result<Vec<mods::ModFolder>, String> {
    if !share.folders.is_empty() && install.cfg.primary().is_bundle() {
        return Err(
            "This game has no app folders, because its mods are laid over the game folder".into(),
        );
    }
    let base = mods::mods_base(install.game_path, install.cfg.primary());
    let native = mods::native_files::NativeGuard::load(install.game_path, install.cfg)?;
    let mut result = Vec::with_capacity(share.folders.len());
    let mut todo = vec![(None::<String>, base, &share.root)];
    while let Some((parent, dir, children)) = todo.pop() {
        // Folder priorities are compacted to their rank among sibling folders on every state
        // read, so the sender's folders held exactly these values. Mods keep their own scale.
        let mut priority = 0;
        let mut names = std::collections::HashSet::new();
        for child in children.iter().rev() {
            match *child {
                ShareChild::Folder(key) => {
                    priority += 1;
                    let folder = &share.folders[key - 1];
                    disk_name(&folder.name)?;
                    if parent.is_none() && folder.name.eq_ignore_ascii_case("disabled") {
                        return Err("disabled is reserved for disabled mods".into());
                    }
                    let disk = if install.cfg.primary().priority_prefix_enabled() {
                        mods::naming::apply_priority_prefix(&folder.name, priority)
                    } else {
                        folder.name.clone()
                    };
                    if !names.insert(disk.to_lowercase()) {
                        return Err(format!("Duplicate folder name '{disk}'"));
                    }
                    let path = dir.join(&disk);
                    mods::native_files::check_contained_path(Path::new(install.game_path), &path)?;
                    native.check_path(&path)?;
                    let id = uuid::Uuid::new_v4().to_string();
                    todo.push((Some(id.clone()), path, &folder.children));
                    result.push(mods::ModFolder {
                        id,
                        display_name: folder.name.clone(),
                        disk_name: disk,
                        priority,
                        parent_id: parent.clone(),
                    });
                }
                ShareChild::Mod(key) => {
                    let pending = &mut rows[key - 1].pending;
                    pending.folder_id = parent.clone();
                    if pending.priority.is_some_and(|p| p < 0) {
                        return Err("Invalid shared mod priority".into());
                    }
                }
            }
        }
    }
    Ok(result)
}

fn begin(
    store: &ProfileStore,
    install: &Install,
    share: &ProfileShare,
    name: &str,
    rows: &mut [ImportRow],
) -> Result<String, String> {
    profiles::require_importable(store, install)?;
    let folders = plan_folders(share, install, rows)?;
    let summary = profiles::create(
        store,
        install,
        name,
        profiles::ProfileSource::Empty {
            keep_loaders: false,
        },
    )?;
    let mut profile = store.get(&summary.id)?;
    profile.folders = folders;
    profile.loaders = Some(share.loaders.clone().unwrap_or_default());
    profile.pending = rows.iter().map(|r| r.pending.clone()).collect();
    store.save(&profile)?;
    profiles::switch(store, install, &profile.id)?;
    Ok(profile.id)
}

fn record_outcome(
    store: &ProfileStore,
    profile_id: &str,
    key: usize,
    outcome: &MemberOutcome,
) -> Result<(), String> {
    let mut profile = store.get(profile_id)?;
    let Some(index) = profile.pending.iter().position(|p| p.member_key == key) else {
        return Err(format!("Profile member {key} is no longer pending"));
    };
    match outcome {
        MemberOutcome::Installed { install_id } => {
            let pending = profile.pending.remove(index);
            profile.members.push(profiles::ProfileMember {
                install_id: install_id.clone(),
                enabled: pending.member.enabled,
                priority: pending.priority,
                folder_id: pending.folder_id,
            });
        }
        MemberOutcome::Pending { reason } => {
            profile.pending[index].reason.clone_from(reason);
            profile.pending[index].needs_install_flow = true;
        }
        MemberOutcome::Failed { error } => {
            profile.pending[index].reason.clone_from(error);
            profile.pending[index].needs_install_flow = false;
        }
    }
    store.save(&profile)
}

fn install_order(rows: &[ImportRow]) -> Vec<usize> {
    let mut indices: Vec<_> = (0..rows.len()).collect();
    indices.sort_by_key(|&i| {
        !rows[i]
            .workshop
            .is_some_and(|(id, _)| mods::host_mods::host_target_by_id(id.into()).is_some())
    });
    indices
}

async fn workshop_member(
    app: &AppHandle,
    install: &Install<'_>,
    store: &ProfileStore,
    profile_id: &str,
    row: &ImportRow,
    mod_id: u32,
    file_id: u32,
) -> MemberOutcome {
    let download = mods::download_workshop_file(
        app,
        mod_id,
        Some(file_id),
        &format!("file:{mod_id}:{file_id}"),
        install.cfg.game_id,
    )
    .await;
    let guard = mods::lock_game_state(app, install.cfg.game_id).await;
    let result = match download {
        Err(error) => Err(error),
        Ok(download) => {
            let path = download.downloaded.clone();
            let result = async {
                mods::switch_launcher(app, install.cfg, install.game_path).await?;
                profiles::require_import_target(store, install, profile_id)?;
                install_workshop_download(install, row, mod_id, file_id, download).await
            }
            .await;
            mods::remove_download(path).await;
            result
        }
    };
    let outcome = persist_result(store, profile_id, row.pending.member_key, result);
    drop(guard);
    if matches!(outcome, MemberOutcome::Installed { .. }) {
        mods::register_download(app, file_id.into()).await;
    }
    outcome
}

fn persist_result(
    store: &ProfileStore,
    id: &str,
    key: usize,
    result: Result<MemberOutcome, String>,
) -> MemberOutcome {
    let outcome = result.unwrap_or_else(|error| MemberOutcome::Failed { error });
    match record_outcome(store, id, key, &outcome) {
        Ok(()) => outcome,
        Err(save) => MemberOutcome::Failed {
            error: format!("Could not save import progress for member {key} ({outcome:?}): {save}"),
        },
    }
}

async fn install_workshop_download(
    install: &Install<'_>,
    row: &ImportRow,
    mod_id: u32,
    file_id: u32,
    download: mods::WorkshopDownload,
) -> Result<MemberOutcome, String> {
    if download.remote_id != i64::from(mod_id) || download.file_id != i64::from(file_id) {
        return Err("The ModWorkshop file changed during import".into());
    }
    let record = mods::InstalledMod {
        name: download.mod_name,
        version: download.mod_version,
        file_type: Some(download.file_type),
        file_id: Some(download.file_id),
        workshop_file_name: download.workshop_file_name,
        workshop_file_label: download.workshop_file_label,
        ..mods::InstalledMod::from_catalog(
            "modworkshop",
            mod_id.to_string(),
            mods::IdentityEvidence::InstallProvenance,
        )
    };
    replay::install_download(install, &row.pending, &download.downloaded, record).await
}

async fn install_profile_loader(
    app: &AppHandle,
    spec: &'static loaders::LoaderSpec,
    install: &Install<'_>,
    profile_id: &str,
) -> Result<bool, String> {
    let (zip, entries) = loaders::download_loader(spec, app).await?;
    let result = async {
        let _guard = mods::lock_game_state(app, install.cfg.game_id).await;
        mods::switch_launcher(app, install.cfg, install.game_path).await?;
        profiles::require_import_target(
            &ProfileStore::new(install.game_path),
            install,
            profile_id,
        )?;
        if loaders::is_loader_installed(
            spec,
            install.cfg.game_id,
            install.game_path,
            install.launcher,
        ) {
            return Ok(false);
        }
        loaders::place_loader(spec, install.game_path, &zip, entries).await?;
        Ok(true)
    }
    .await;
    mods::remove_download(zip).await;
    result
}

pub(in crate::commands::mods) async fn run(
    app: &AppHandle,
    share: ProfileShare,
    path: String,
    name: String,
    choices: BTreeMap<String, u32>,
) -> Result<ProfileImportResult, String> {
    let cfg = mods::engine_for_game(&share.game_id)?;
    let state_path = mods::get_state_path(&path, cfg);
    let store = ProfileStore::new(&path);
    let install = |launcher| Install {
        game_path: &path,
        state_path: &state_path,
        cfg,
        launcher,
    };
    {
        let _guard = mods::lock_game_state(app, cfg.game_id).await;
        let launcher = mods::switch_launcher(app, cfg, &path).await?;
        profiles::require_importable(
            &store,
            &Install {
                launcher: launcher.as_deref(),
                ..install(None)
            },
        )?;
    }
    let preview = preview::for_install(app.clone(), share.clone(), path.clone()).await?;
    let mut rows = resolve_rows(&share, preview, choices)?;
    let guard = mods::lock_game_state(app, cfg.game_id).await;
    let launcher = mods::switch_launcher(app, cfg, &path).await?;
    let install = install(launcher.as_deref());
    let profile_id = begin(&store, &install, &share, &name, &mut rows)?;
    drop(guard);

    let mut loader_results = BTreeMap::new();
    for id in share.loaders.iter().flatten() {
        let spec = loaders::loader_spec(id).expect("validated loose loader");
        let outcome = if loaders::is_loader_installed(spec, cfg.game_id, &path, launcher.as_deref())
        {
            LoaderOutcome::AlreadyPresent
        } else if matches!(spec.install, InstallStrategy::ViaModFlow) {
            LoaderOutcome::ViaModFlow
        } else {
            match install_profile_loader(app, spec, &install, &profile_id).await {
                Ok(true) => LoaderOutcome::Installed,
                Ok(false) => LoaderOutcome::AlreadyPresent,
                Err(error) => LoaderOutcome::Failed { error },
            }
        };
        // Keyed by name, since the result is only ever shown.
        loader_results.insert(spec.name.to_string(), outcome);
    }
    let mut members = Vec::with_capacity(rows.len());
    let mut newer_versions = 0;
    for index in install_order(&rows) {
        let row = &rows[index];
        let key = row.pending.member_key;
        let outcome = match row.workshop {
            Some((mod_id, file_id)) => {
                workshop_member(app, &install, &store, &profile_id, row, mod_id, file_id).await
            }
            None if row.lookup_failed => MemberOutcome::Failed {
                error: row.pending.reason.clone(),
            },
            None => MemberOutcome::Pending {
                reason: row.pending.reason.clone(),
            },
        };
        newer_versions +=
            usize::from(row.newer && matches!(outcome, MemberOutcome::Installed { .. }));
        if let Err(e) = app.emit(
            "profile-share:import-progress",
            serde_json::json!({
                "done":members.len()+1, "total":rows.len(), "memberKey":key, "outcome":outcome
            }),
        ) {
            log::warn!("Could not emit profile import progress: {e}");
        }
        members.push(ImportMemberResult {
            member_key: key,
            outcome,
        });
    }
    members.sort_by_key(|m| m.member_key);
    Ok(ProfileImportResult {
        profile_id,
        members,
        loaders: loader_results,
        newer_versions,
    })
}

fn matching_nexus(
    store: &ProfileStore,
    game: &str,
    mod_id: u32,
    file_id: u32,
) -> Result<Option<(String, Vec<PendingReference>)>, String> {
    let Some(id) = store.active()? else {
        return Ok(None);
    };
    let Some(profile) = store.find(&id)? else {
        return Ok(None);
    };
    let matches: Vec<_> = profile.pending.into_iter().filter(|p|
        p.game_id == game && p.file_id == Some(file_id) &&
        matches!(p.member.file, ShareFile::Nexus { mod_id: other, .. } if other == mod_id)
    ).collect();
    Ok((!matches.is_empty()).then_some((id, matches)))
}

pub(in crate::commands::mods) async fn complete_nexus(
    app: &AppHandle,
    cfg: &'static mods::ModEngineConfig,
    path: &str,
    archive: &Path,
    meta: &mods::NexusInstallMeta,
) -> Result<bool, String> {
    let _guard = mods::lock_game_state(app, cfg.game_id).await;
    let store = ProfileStore::new(path);
    let Some((profile_id, matches)) =
        matching_nexus(&store, cfg.game_id, meta.mod_id, meta.file_id)?
    else {
        return Ok(false);
    };
    let launcher = mods::configured_launcher(app, cfg);
    let install = Install {
        game_path: path,
        cfg,
        state_path: &mods::get_state_path(path, cfg),
        launcher: launcher.as_deref(),
    };
    profiles::require_import_target(&store, &install, &profile_id)?;
    mods::resources::ensure_not_running(app, cfg.game_id).await?;
    let mut errors = Vec::new();
    for reference in matches {
        // Each replay owns its staging file. Several shared entries can refer to the same Nexus download.
        let copy = std::env::temp_dir()
            .join(uuid::Uuid::new_v4().to_string())
            .with_extension(archive.extension().unwrap_or_default());
        tokio::fs::copy(archive, &copy)
            .await
            .map_err(|e| format!("Could not stage the Nexus download: {e}"))?;
        let outcome =
            install_nexus_member(&store, &profile_id, &install, &reference, &copy, meta).await?;
        match outcome {
            MemberOutcome::Installed { .. } => {}
            MemberOutcome::Failed { error } => errors.push(error),
            MemberOutcome::Pending { reason } => errors.push(reason),
        }
    }
    if errors.is_empty() {
        Ok(true)
    } else {
        Err(errors.join(". "))
    }
}

async fn install_nexus_member(
    store: &ProfileStore,
    profile_id: &str,
    install: &Install<'_>,
    reference: &PendingReference,
    archive: &Path,
    meta: &mods::NexusInstallMeta,
) -> Result<MemberOutcome, String> {
    let record = mods::InstalledMod {
        name: meta.name.clone(),
        version: meta.version.clone(),
        author: meta.author.clone(),
        thumbnail_url: meta.thumbnail_url.clone(),
        file_type: Some(meta.file_type.clone()),
        file_remote_id: Some(meta.file_id.to_string()),
        file_id: Some(meta.file_id.into()),
        ..mods::InstalledMod::from_catalog(
            "nexus",
            meta.mod_id.to_string(),
            mods::IdentityEvidence::InstallProvenance,
        )
    };
    let result = replay::install_download(install, reference, archive, record).await;
    Ok(persist_result(
        store,
        profile_id,
        reference.member_key,
        result,
    ))
}

/// What the profile menu offers for a shared mod the active profile is waiting for.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PendingAction {
    NexusDownload,
    ChooseFile,
    TryAgain,
    OpenMod,
}

/// A shared mod the active profile is still waiting for, as the profile menu lists it.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingShareMember {
    member_key: usize,
    action: PendingAction,
    source: preview::ShareSource,
    mod_id: u32,
    file_id: Option<u32>,
    installed_name: String,
    reason: String,
    // The Nexus link starts that file's Mod Manager Download, which the completion matches.
    url: String,
}

pub(in crate::commands::mods) fn pending_members(
    profile: &profiles::Profile,
) -> Vec<PendingShareMember> {
    profile
        .pending
        .iter()
        .map(|p| {
            let (source, mod_id, url) = match p.member.file {
                ShareFile::ModWorkshop { mod_id, .. } => (
                    preview::ShareSource::ModWorkshop,
                    mod_id,
                    format!("https://modworkshop.net/mod/{mod_id}"),
                ),
                ShareFile::Nexus { mod_id, .. } => {
                    let domain = crate::commands::sources::native_id("nexus", &p.game_id)
                        .expect("the share parser checked the Nexus binding");
                    let url = match p.file_id {
                        Some(file) => format!(
                            "https://www.nexusmods.com/{domain}/mods/{mod_id}?tab=files&file_id={file}&nmm=1"
                        ),
                        None => format!("https://www.nexusmods.com/{domain}/mods/{mod_id}?tab=files"),
                    };
                    (preview::ShareSource::Nexus, mod_id, url)
                }
            };
            let action = match (&p.member.file, p.file_id) {
                (_, None) => PendingAction::ChooseFile,
                (ShareFile::Nexus { .. }, Some(_)) => PendingAction::NexusDownload,
                (ShareFile::ModWorkshop { .. }, Some(_)) if p.needs_install_flow => {
                    PendingAction::OpenMod
                }
                (ShareFile::ModWorkshop { .. }, Some(_)) => PendingAction::TryAgain,
            };
            PendingShareMember {
                member_key: p.member_key,
                action,
                source,
                mod_id,
                file_id: p.file_id,
                installed_name: p.member.installed_name.clone(),
                reason: p.reason.clone(),
                url,
            }
        })
        .collect()
}

fn active_pending(store: &ProfileStore, key: usize) -> Result<(profiles::Profile, usize), String> {
    let id = store.active()?.ok_or("No profile is active")?;
    let profile = store.get(&id)?;
    let index = profile
        .pending
        .iter()
        .position(|p| p.member_key == key)
        .ok_or("That shared mod is no longer waiting to be installed")?;
    Ok((profile, index))
}

/// The files a waiting shared mod can be installed from.
pub(in crate::commands::mods) async fn member_files(
    app: &AppHandle,
    cfg: &'static mods::ModEngineConfig,
    path: &str,
    key: usize,
) -> Result<Vec<preview::PreviewFile>, String> {
    let reference = {
        let _guard = mods::lock_game_state(app, cfg.game_id).await;
        let (profile, index) = active_pending(&ProfileStore::new(path), key)?;
        profile.pending[index].clone()
    };
    preview::member_files(app, &reference.game_id, &reference.member.file).await
}

/// Records the file the user picked for a waiting shared mod. A Nexus pick then waits for its
/// Mod Manager Download, which the completion matches by this file.
pub(in crate::commands::mods) async fn choose_file(
    app: &AppHandle,
    cfg: &'static mods::ModEngineConfig,
    path: &str,
    key: usize,
    file_id: u32,
) -> Result<PendingShareMember, String> {
    let files = member_files(app, cfg, path, key).await?;
    if !files.iter().any(|f| f.id == file_id) {
        return Err(format!("File {file_id} is not one of this mod's files"));
    }
    let _guard = mods::lock_game_state(app, cfg.game_id).await;
    let store = ProfileStore::new(path);
    let (mut profile, index) = active_pending(&store, key)?;
    let pending = &mut profile.pending[index];
    pending.file_id = Some(file_id);
    pending.needs_install_flow = false;
    pending.reason = match pending.member.file {
        ShareFile::Nexus { .. } => "Waiting for a Nexus download".into(),
        ShareFile::ModWorkshop { .. } => "Waiting for installation".into(),
    };
    store.save(&profile)?;
    Ok(pending_members(&profile).swap_remove(index))
}

/// Installs a waiting ModWorkshop mod through the import's own installer, into the place the
/// shared profile had it.
pub(in crate::commands::mods) async fn install_member(
    app: &AppHandle,
    cfg: &'static mods::ModEngineConfig,
    path: String,
    key: usize,
) -> Result<MemberOutcome, String> {
    let store = ProfileStore::new(&path);
    let (profile_id, reference) = {
        let _guard = mods::lock_game_state(app, cfg.game_id).await;
        let (profile, index) = active_pending(&store, key)?;
        (profile.id.clone(), profile.pending[index].clone())
    };
    let ShareFile::ModWorkshop { mod_id, .. } = reference.member.file else {
        return Err("A Nexus mod installs through its Nexus download".into());
    };
    let file_id = reference.file_id.ok_or("Choose a file first")?;
    let launcher = mods::configured_launcher(app, cfg);
    let state_path = mods::get_state_path(&path, cfg);
    let install = Install {
        game_path: &path,
        state_path: &state_path,
        cfg,
        launcher: launcher.as_deref(),
    };
    let row = ImportRow {
        pending: reference,
        workshop: Some((mod_id, file_id)),
        newer: false,
        lookup_failed: false,
    };
    Ok(workshop_member(app, &install, &store, &profile_id, &row, mod_id, file_id).await)
}

/// Places a ModWorkshop mod the user installed through the normal flow where the shared profile
/// had it, when the active profile is waiting for that mod, the way a Nexus completion does.
/// Runs inside the install's own state lock.
pub(in crate::commands::mods) fn adopt_workshop(
    install: &Install,
    uid: &str,
) -> Result<(), String> {
    let store = ProfileStore::new(install.game_path);
    let Some(id) = store.active()? else {
        return Ok(());
    };
    let Some(profile) = store.find(&id)? else {
        return Ok(());
    };
    let state = install.read()?;
    let record = state
        .mods
        .iter()
        .find(|m| m.uid == uid)
        .ok_or("The installed record is missing")?;
    let Some(remote) = record
        .remote_id
        .as_deref()
        .filter(|_| record.source == "modworkshop")
    else {
        return Ok(());
    };
    let waiting: Vec<_> = profile
        .pending
        .iter()
        .filter(|p| {
            matches!(p.member.file, ShareFile::ModWorkshop { mod_id, .. } if mod_id.to_string() == remote)
        })
        .collect();
    // Of several waiting files of one mod, the one installed under the same name is this one.
    let name = super::installed_name(install.cfg, record);
    let Some(reference) = waiting
        .iter()
        .find(|p| p.member.installed_name.eq_ignore_ascii_case(&name))
        .or(waiting.first())
        .map(|p| (*p).clone())
    else {
        return Ok(());
    };
    // A shared folder the user has since deleted leaves the mod where it was installed.
    let folder_exists = reference
        .folder_id
        .as_ref()
        .is_none_or(|f| state.folders.iter().any(|folder| &folder.id == f));
    if folder_exists && record.folder_id != reference.folder_id {
        mods::reorder::move_mod_to_folder_op(
            install.game_path,
            install.state_path,
            uid,
            reference.folder_id.clone(),
            0,
            install.cfg,
        )?;
    }
    let outcome = replay::finish(install, &reference, uid)?;
    record_outcome(&store, &id, reference.member_key, &outcome)
}

/// Stops the active profile waiting for a shared mod the user will not install.
pub(in crate::commands::mods) fn dismiss(
    store: &ProfileStore,
    member_key: usize,
) -> Result<(), String> {
    let id = store.active()?.ok_or("No profile is active")?;
    let mut profile = store.get(&id)?;
    let before = profile.pending.len();
    profile.pending.retain(|p| p.member_key != member_key);
    if profile.pending.len() == before {
        return Err("That shared mod is no longer waiting to be installed".into());
    }
    store.save(&profile)
}

#[cfg(test)]
#[path = "share_import_tests.rs"]
mod tests;

use std::path::Path;

use super::{disk_name, Install, MemberOutcome, PendingReference};
use crate::commands::mods::{
    self,
    cleanup::{self, CleanupPlan},
    decisions, profiles,
    staged::{NameSource, Staged},
    staging_tokens::StagedArchiveKind,
    zip, InstallPrompt, InstalledMod, ResolveError, StagingRegistry, TopLevelItem,
};

fn pending(reason: &str) -> MemberOutcome {
    MemberOutcome::Pending {
        reason: reason.into(),
    }
}

fn selected(entries: &[String], recorded: Option<&str>, name: &str) -> Option<usize> {
    let unique = |matches: Vec<usize>| match matches.as_slice() {
        [only] => Some(*only),
        _ => None,
    };
    if let Some(selector) = recorded {
        let selector = super::super::archive_selector(selector).ok()?;
        let exact: Vec<_> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                super::super::archive_selector(entry).is_ok_and(|entry| entry == selector)
            })
            .map(|(i, _)| i)
            .collect();
        if !exact.is_empty() {
            return unique(exact);
        }
    }
    unique(
        entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                entry
                    .trim_end_matches(['/', '\\'])
                    .rsplit(['/', '\\'])
                    .next()
                    .is_some_and(|base| base.eq_ignore_ascii_case(name))
            })
            .map(|(i, _)| i)
            .collect(),
    )
}

pub(super) fn finish(
    install: &Install,
    reference: &PendingReference,
    uid: &str,
) -> Result<MemberOutcome, String> {
    let cfg = install.cfg;
    let state = install.read()?;
    let record = state
        .mods
        .iter()
        .find(|m| m.uid == uid)
        .ok_or("The imported installation record is missing")?;
    let id = record.install_id.clone();
    if cfg.game_id == "cb"
        && reference.member.target.as_deref() == Some("paks")
        && cfg.mod_target(record).tag != "paks"
    {
        mods::move_crimeboss_mod_target_op(
            install.game_path,
            install.state_path,
            uid,
            cfg,
            install.launcher,
        )?;
    }
    if !reference.member.enabled {
        mods::disable_mod_op(
            install.game_path,
            install.state_path,
            uid,
            cfg,
            install.launcher,
        )?;
    }
    if let Some(priority) = reference.priority {
        let item = TopLevelItem::Mod { id: uid.into() };
        mods::reorder::apply_child_priorities(
            install.game_path,
            install.state_path,
            reference.folder_id.as_deref(),
            install.read()?,
            [(&item, priority)],
            cfg,
        )?;
    }
    Ok(MemberOutcome::Installed { install_id: id })
}

async fn place(
    install: &Install<'_>,
    reference: &PendingReference,
    mut record: InstalledMod,
    staged: &Staged,
) -> Result<MemberOutcome, String> {
    let cfg = install.cfg;
    let target = cfg.target_for(staged.target_tag.as_deref());
    let legacy = cfg.game_id == "cb"
        && reference.member.target.as_deref() == Some("paks")
        && target.tag == cfg.primary().tag;
    if reference
        .member
        .target
        .as_deref()
        .is_some_and(|tag| tag != target.tag)
        && !legacy
    {
        return Ok(pending(
            "The current upload installs into a different location than the shared one",
        ));
    }
    if reference.folder_id.is_some() && target.tag != cfg.primary().tag {
        return Ok(pending(
            "This mod installs where app folders are not available",
        ));
    }
    disk_name(&record.filename)?;
    let state = install.read()?;
    if reference
        .folder_id
        .as_ref()
        .is_some_and(|id| !state.folders.iter().any(|folder| &folder.id == id))
    {
        return Ok(pending("The imported folder no longer exists"));
    }
    let conflicts = state.mods.iter().any(|other| {
        other.uid == record.uid
            || (cfg.mod_target(other).tag == target.tag
                && other.folder_id == reference.folder_id
                && !target.priority_prefix_enabled()
                && other.filename.eq_ignore_ascii_case(&record.filename))
    });
    if conflicts {
        return Ok(pending(
            "Another installation already uses this file or folder",
        ));
    }
    record.sha256 = Some(mods::staged_content_sha256(target, &staged.root).await?);
    let uid = record.uid.clone();
    mods::install_mod_from_path(
        install.game_path,
        install.state_path,
        record,
        &staged.root,
        reference.folder_id.clone(),
        cfg,
        target,
    )?;
    finish(install, reference, &uid)
}

fn host_pack(
    install: &Install,
    reference: &PendingReference,
    path: &Path,
    mut record: InstalledMod,
    pack: zip::HostPackPayload,
) -> Result<MemberOutcome, String> {
    let Some(set) = reference.member.host_pack_set.as_deref() else {
        return Ok(pending("Choose which add-on to install"));
    };
    let Some(index) = selected(
        &pack.entries,
        reference.member.archive_member.as_deref(),
        set,
    ) else {
        return Ok(pending("Choose which add-on to install"));
    };
    let entry = &pack.entries[index];
    let (_, name) = mods::entry_names(entry);
    disk_name(&name)?;
    let state = install.read()?;
    let Some(host) = mods::paths::resolve_host_mod_dir(
        install.game_path,
        install.cfg,
        &state.mods,
        &state.folders,
        pack.host_mod_id,
    ) else {
        return Ok(pending(&format!("Install {} first", pack.host_name)));
    };
    let uid = format!("{}_{}", record.file_id.expect("catalog file"), name);
    if state.mods.iter().any(|m| m.uid == uid)
        || host
            .join(&pack.host_subpath)
            .join(name)
            .try_exists()
            .map_err(|e| e.to_string())?
    {
        return Ok(pending("This add-on is already installed"));
    }
    record.location = Some(format!("host:{}:{}", pack.host_mod_id, pack.host_subpath));
    record.archive_member = Some(entry.clone());
    mods::install_host_pack_op(
        install.game_path,
        install.state_path,
        path,
        entry,
        record,
        install.cfg,
    )?;
    finish(install, reference, &uid)
}

async fn replay(
    install: &Install<'_>,
    reference: &PendingReference,
    path: &Path,
    mut record: InstalledMod,
    registry: &StagingRegistry,
) -> Result<MemberOutcome, String> {
    let cfg = install.cfg;
    if let Some(existing) = install
        .read()?
        .mods
        .iter()
        .find(|m| m.install_id == reference.install_id)
    {
        return finish(install, reference, &existing.uid);
    }
    record.install_id.clone_from(&reference.install_id);
    let file = record.file_id.expect("resolved catalog file");
    record.uid = if record.source == "nexus" {
        format!(
            "nexus:{}:{file}",
            record.remote_id.as_deref().expect("catalog mod")
        )
    } else {
        file.to_string()
    };
    let resolved = zip::resolve_with_selection(path.into(), cfg, registry, true);
    let staged = match resolved {
        Ok(staged) => {
            if reference.member.archive_member.is_some() || reference.member.host_pack_set.is_some()
            {
                cleanup::run_staged(&staged.cleanup, staged.original_archive).await;
                return Ok(pending(
                    "The file picked from this archive is no longer in it",
                ));
            }
            record.filename = decisions::install_filename_for_source_file(
                cfg,
                cfg.target_for(staged.target_tag.as_deref()),
                &record.name,
                file,
                record.file_type.as_deref().unwrap_or(""),
                &staged.root,
                staged.name_source,
            );
            staged
        }
        Err(ResolveError::Prompt(prompt)) => match *prompt {
            InstallPrompt::ZipMultiPak(picker) => {
                if reference.member.host_pack_set.is_some() {
                    return Ok(pending("The shared add-on is no longer in this archive"));
                }
                let Some(i) = selected(
                    &picker.entries,
                    reference.member.archive_member.as_deref(),
                    &reference.member.installed_name,
                ) else {
                    return Ok(pending("Choose a file from the archive"));
                };
                let entry = registry
                    .entry(
                        &picker.archive_handle,
                        StagedArchiveKind::MultiEntry,
                        picker.entry_ids[i],
                    )
                    .ok_or("Archive entry expired")?;
                let tag = picker
                    .entry_tags
                    .as_ref()
                    .map_or(picker.target_tag.as_ref(), |tags| tags[i].as_ref())
                    .cloned();
                let target = cfg.target_for(tag.as_deref());
                let normalized = entry.display_name.replace('\\', "/");
                let (stem, filename) = mods::entry_names(&normalized);
                disk_name(&filename)?;
                let cb_dir = decisions::is_cb_dir_entry(cfg, picker.entry_kind.as_deref());
                let (root, cleanup) =
                    mods::stage_archive_entry(cfg, target, path, &entry, cb_dir, &filename)?;
                record.filename =
                    decisions::install_filename_for_zip_entry(cfg, &record.name, &filename);
                record.uid = if record.source == "nexus" {
                    format!("{}:entry:{normalized}", record.uid)
                } else {
                    format!("{file}_{stem}")
                };
                record.archive_member = Some(normalized);
                Staged {
                    root,
                    cleanup,
                    name_source: NameSource::FromArchive,
                    target_tag: tag,
                    original_archive: None,
                }
            }
            InstallPrompt::HostModPack(pack) => {
                return host_pack(install, reference, path, record, pack)
            }
            InstallPrompt::CbFlatArchive(_) => {
                return Ok(pending("Confirm installing this archive as a mod folder"))
            }
            InstallPrompt::UnrecognizedArchive => {
                return Ok(pending(
                    "Review the author's install instructions for this archive",
                ))
            }
        },
        Err(ResolveError::Resources(_)) => {
            return Ok(pending("Review what this mod changes before installing it"))
        }
        Err(ResolveError::Ue4ssLoader(_)) => return Ok(pending("Install UE4SS from its mod page")),
        Err(ResolveError::Failure(error)) => return Err(error),
    };
    let result = place(install, reference, record, &staged).await;
    cleanup::run_staged(&staged.cleanup, staged.original_archive).await;
    result
}

pub(super) async fn install_download(
    install: &profiles::Install<'_>,
    reference: &PendingReference,
    path: &Path,
    record: InstalledMod,
) -> Result<MemberOutcome, String> {
    let registry = StagingRegistry::new();
    let result = replay(install, reference, path, record, &registry).await;
    for cleanup in registry.drain() {
        cleanup::run(&cleanup).await;
    }
    cleanup::run(&CleanupPlan::RemoveOwnedFile(path.into())).await;
    result
}

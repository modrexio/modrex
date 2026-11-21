use std::collections::{BTreeMap, BTreeSet, HashMap};
use tauri::{AppHandle, Emitter};

use super::super::{ProfileShare, ShareFile};
use super::{Catalog, Files, LookupIssue, PreviewFile};
use crate::commands::{api, domain, nexus, nexus_oauth, sources};

#[derive(serde::Deserialize)]
struct WorkshopListing {
    data: Vec<ListedMod>,
}

#[derive(serde::Deserialize)]
pub(super) struct ListedMod {
    id: u32,
    #[serde(default)]
    disable_mod_managers: serde_json::Value,
}

async fn workshop_batch(
    app: &AppHandle,
    game_id: &str,
    ids: &[u32],
) -> Result<HashMap<u32, ListedMod>, String> {
    let mut query = vec![("limit", ids.len().to_string())];
    query.extend(ids.iter().map(|id| ("ids[]", id.to_string())));
    let value = api::api_get(app, &format!("/games/{game_id}/mods"), query).await?;
    let page: WorkshopListing = serde_json::from_value(value)
        .map_err(|e| format!("ModWorkshop mod listing did not parse: {e}"))?;
    Ok(page.data.into_iter().map(|m| (m.id, m)).collect())
}

pub(super) fn workshop_availability(summary: Option<&ListedMod>) -> Result<(), LookupIssue> {
    use serde_json::Value;
    match summary.map(|m| &m.disable_mod_managers) {
        None => Err(LookupIssue::Unavailable(
            "The mod is missing or hidden for this game".into(),
        )),
        Some(Value::Bool(true)) => Err(LookupIssue::Unavailable(
            "The author disabled mod manager downloads".into(),
        )),
        Some(Value::Bool(false) | Value::Null) => Ok(()),
        Some(_) => Err(LookupIssue::Failed(
            "Invalid ModWorkshop mod manager setting".into(),
        )),
    }
}

async fn workshop_files(app: &AppHandle, mod_id: u32, summary: Option<&ListedMod>) -> Files {
    workshop_availability(summary)?;
    let files = api::mod_file_pages(app, mod_id)
        .await
        .map_err(|error| match error {
            api::WorkshopLookupError::Unavailable(reason) => LookupIssue::Unavailable(reason),
            api::WorkshopLookupError::Failed(reason) => LookupIssue::Failed(reason),
        })?;
    preview_files(files.data)
}

fn preview_files(files: Vec<domain::ModFile>) -> Files {
    files
        .into_iter()
        .map(PreviewFile::try_from)
        .collect::<Result<_, _>>()
        .map_err(LookupIssue::Failed)
}

fn nexus_issue(message: String) -> LookupIssue {
    match message.as_str() {
        nexus_oauth::SIGN_IN_REQUIRED | nexus_oauth::SESSION_EXPIRED => {
            LookupIssue::NexusSignInRequired
        }
        _ => LookupIssue::Failed(message),
    }
}

async fn nexus_pin(
    app: &AppHandle,
    domain: &str,
    mod_id: u32,
    id: u32,
) -> Result<Option<PreviewFile>, LookupIssue> {
    let Some(value) = nexus_metadata(app, domain, mod_id, Some(id)).await? else {
        return Ok(None);
    };
    domain::parse_nexus_share_pin(value, domain, mod_id, id)
        .and_then(|file| file.map(PreviewFile::try_from).transpose())
        .map_err(LookupIssue::Failed)
}

async fn nexus_metadata(
    app: &AppHandle,
    domain: &str,
    mod_id: u32,
    id: Option<u32>,
) -> Result<Option<serde_json::Value>, LookupIssue> {
    match nexus::share_file_lookup(app, domain, mod_id, id)
        .await
        .map_err(nexus_issue)?
    {
        nexus::NexusFileMetadata::Found(value) => Ok(Some(value)),
        nexus::NexusFileMetadata::Missing => Ok(None),
        nexus::NexusFileMetadata::Forbidden => Err(LookupIssue::Unavailable(
            "Nexus denied access to this mod or file".into(),
        )),
    }
}

async fn nexus_choices(app: &AppHandle, domain: &str, mod_id: u32) -> Files {
    let value = nexus_metadata(app, domain, mod_id, None)
        .await?
        .ok_or_else(|| LookupIssue::Unavailable("The Nexus mod is missing or hidden".into()))?;
    preview_files(
        domain::parse_nexus_share_choices(value, domain, mod_id).map_err(LookupIssue::Failed)?,
    )
}

pub(super) async fn catalog(app: &AppHandle, share: &ProfileShare) -> Catalog {
    let mut workshop = BTreeSet::new();
    let mut nexus = BTreeMap::<u32, BTreeSet<Option<u32>>>::new();
    for member in &share.members {
        match member.file {
            ShareFile::ModWorkshop { mod_id, .. } => {
                workshop.insert(mod_id);
            }
            ShareFile::Nexus { mod_id, file_id } => {
                nexus.entry(mod_id).or_default().insert(file_id);
            }
        }
    }
    let total = workshop.len() + nexus.len();
    let progress = |done: usize| {
        if let Err(error) = app.emit(
            "profile-share:progress",
            serde_json::json!({ "done": done, "total": total }),
        ) {
            log::warn!("Could not emit profile preview progress: {error}");
        }
    };
    let mut catalog = Catalog::default();
    let mut done = 0;
    progress(done);
    if !workshop.is_empty() {
        let game = sources::native_id("modworkshop", &share.game_id)
            .expect("the share parser checked the Workshop binding");
        let ids: Vec<_> = workshop.into_iter().collect();
        match api::get_mod_versions(app.clone(), ids.clone()).await {
            Ok(versions) => catalog
                .workshop_versions
                .extend(versions.into_iter().filter_map(|v| match v {
                    api::ModVersionResult::Known { id, version } => Some((id, version)),
                    _ => None,
                })),
            Err(error) => log::warn!("Profile preview could not read mod versions: {error}"),
        }
        for batch in ids.chunks(50) {
            let summaries = workshop_batch(app, &game, batch).await;
            for &id in batch {
                let files = match &summaries {
                    Ok(mods) => workshop_files(app, id, mods.get(&id)).await,
                    Err(error) => Err(LookupIssue::Failed(error.clone())),
                };
                catalog.workshop.insert(id, files);
                done += 1;
                progress(done);
            }
        }
    }
    if nexus.is_empty() {
        return catalog;
    }
    let domain = sources::native_id("nexus", &share.game_id)
        .expect("the share parser checked the Nexus binding");
    let signed_in = nexus_oauth::nexus_oauth_signed_in(app.clone());
    for (mod_id, pins) in nexus {
        let mut needs_choices = pins.contains(&None);
        for id in pins.into_iter().flatten() {
            let file = if signed_in {
                nexus_pin(app, &domain, mod_id, id).await
            } else {
                Err(LookupIssue::NexusSignInRequired)
            };
            needs_choices |= matches!(file, Ok(None));
            catalog.nexus_pins.insert((mod_id, id), file);
        }
        if needs_choices {
            let files = if signed_in {
                nexus_choices(app, &domain, mod_id).await
            } else {
                Err(LookupIssue::NexusSignInRequired)
            };
            catalog.nexus_choices.insert(mod_id, files);
        }
        done += 1;
        progress(done);
    }
    catalog
}

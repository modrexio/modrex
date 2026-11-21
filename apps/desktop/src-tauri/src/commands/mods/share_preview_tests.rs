use super::*;
use crate::commands::domain::{parse_file_page, parse_nexus_share_choices, parse_nexus_share_pin};
use serde_json::{json, Value};
use std::fs;

fn member(file: Value, installed_name: &str) -> Value {
    json!({"file":file, "enabled":true, "folder":null, "priority":null, "installedName":installed_name})
}

fn share(members: Vec<Value>) -> Value {
    let root: Vec<_> = (1..=members.len()).map(|key| json!({"mod":key})).collect();
    json!({"format":"modrex-profile","schemaVersion":1,"gameId":"pd3","profileName":"Stealth",
           "root":root,"folders":[],"members":members,"loaders":[]})
}

fn preview(members: Vec<Value>, catalog: &Catalog) -> Value {
    let share = super::super::parse(&share(members).to_string()).unwrap();
    let cfg = super::super::engine_for_game(&share.game_id).unwrap();
    serde_json::to_value(resolve(&share, cfg, catalog, vec![])).unwrap()
}

fn workshop(files: Value) -> Catalog {
    let files = parse_file_page(json!({"data":files}))
        .unwrap()
        .data
        .into_iter()
        .map(PreviewFile::try_from)
        .collect::<Result<_, _>>()
        .unwrap();
    Catalog {
        workshop: HashMap::from([(32443, Ok(files))]),
        workshop_versions: HashMap::from([(32443, "1.4".into())]),
        ..Catalog::default()
    }
}

fn variants() -> Value {
    json!([
        {"id":89916,"name":"Special","label":"SPECIAL","version":"3.4.0","size":300},
        {"id":89898,"name":"Main","label":"MAIN","version":"3.4.0","size":200},
        {"id":89900,"name":"Steam","label":"Steam build","version":"1.4","size":100}
    ])
}

fn workshop_member(hints: Value, installed_name: &str) -> Value {
    let mut file = json!({"source":"modworkshop","modId":32443});
    file.as_object_mut()
        .unwrap()
        .extend(hints.as_object().unwrap().clone());
    member(file, installed_name)
}

fn row(hints: Value, installed_name: &str, files: Value) -> Value {
    preview(
        vec![workshop_member(hints, installed_name)],
        &workshop(files),
    )["rows"][0]
        .clone()
}

#[test]
fn workshop_pin_selects_shared_variant_over_primary_and_latest() {
    let row = row(
        json!({"fileId":89900,"fileName":"Main","label":"SPECIAL","version":"1.2"}),
        "Main.pak",
        variants(),
    );
    assert_eq!(row["sharedVersion"], "1.2");
    assert_eq!(row["installVersion"], "1.4");
    assert_eq!(
        row["resolution"],
        json!({"status":"ready","foundByName":false,
        "file":{"id":89900,"name":"Steam","label":"Steam build","version":"1.4","size":100}})
    );
}

#[test]
fn workshop_reupload_matches_file_name_then_label_then_installed_name() {
    for (hints, name, id) in [
        (
            json!({"fileId":1,"fileName":"Steam","label":"MAIN"}),
            "Special.pak",
            89900,
        ),
        (
            json!({"fileId":1,"fileName":"Renamed","label":"MAIN"}),
            "Special.pak",
            89898,
        ),
        (
            json!({"fileId":1,"fileName":"Renamed","label":"Gone"}),
            "special.pak",
            89916,
        ),
    ] {
        let resolution = &row(hints, name, variants())["resolution"];
        assert_eq!(resolution["file"]["id"], id);
        assert_eq!(resolution["foundByName"], true);
    }
}

#[test]
fn ambiguous_or_unmatched_workshop_reupload_needs_a_choice() {
    let files = json!([{"id":1,"name":"HUD"},{"id":2,"name":"HUD"}]);
    for candidates in [files, json!([{"id":1,"name":"Unrelated"}])] {
        let row = row(
            json!({"fileId":99,"fileName":"HUD","version":"1.2"}),
            "HUD.pak",
            candidates.clone(),
        );
        assert_eq!(row["resolution"]["status"], "needsChoice");
        assert_eq!(
            row["resolution"]["candidates"].as_array().unwrap().len(),
            candidates.as_array().unwrap().len()
        );
        assert_eq!(row["sharedVersion"], "1.2");
        assert!(row["installVersion"].is_null());
    }
}

#[test]
fn page_only_workshop_uses_only_file_or_unique_installed_name() {
    let one = row(json!({}), "Other.pak", json!([{"id":42,"name":"HUD"}]));
    assert_eq!(one["resolution"]["file"]["id"], 42);
    assert_eq!(one["resolution"]["foundByName"], false);
    let matched = row(
        json!({"fileName":"Main","label":"MAIN"}),
        "Steam.pak",
        variants(),
    );
    assert_eq!(matched["resolution"]["file"]["id"], 89900);
    assert_eq!(matched["resolution"]["foundByName"], true);
    let choose = row(json!({}), "Missing.pak", variants());
    assert_eq!(
        choose["resolution"]["candidates"].as_array().unwrap().len(),
        3
    );
}

#[test]
fn missing_hidden_link_only_and_manager_disabled_mods_are_unavailable() {
    let listed = serde_json::from_value(json!({"id":32443,"disable_mod_managers":true})).unwrap();
    let member = workshop_member(json!({}), "HUD.pak");
    for (summary, reason) in [(None, "missing or hidden"), (Some(&listed), "disabled")] {
        let issue = fetch::workshop_availability(summary).unwrap_err();
        let catalog = Catalog {
            workshop: HashMap::from([(32443, Err(issue))]),
            ..Catalog::default()
        };
        let result = preview(vec![member.clone()], &catalog);
        let resolution = &result["rows"][0]["resolution"];
        assert_eq!(resolution["status"], "unavailable");
        assert!(resolution["reason"].as_str().unwrap().contains(reason));
        assert_eq!(result["failedSources"], json!([]));
    }
    let result = preview(vec![member], &workshop(json!([])));
    assert_eq!(
        result["rows"][0]["resolution"],
        json!({"status":"unavailable","reason":"This mod has no files to download"})
    );
}

fn nexus_member(id: Option<u32>, name: &str) -> Value {
    member(json!({"source":"nexus","modId":12,"fileId":id}), name)
}

fn nexus_catalog() -> Catalog {
    let files = json!([
        {"file_id":3,"name":"Archived HUD","category_id":7,"version":"1.2","size_kb":1,"size_in_bytes":999},
        {"file_id":4,"name":"Old","category_id":4},
        {"file_id":5,"name":"Removed","category_id":6},
        {"file_id":6,"name":"New HUD","category_id":1,"version":"2","size_kb":3}
    ]);
    let pins = [(3, 0), (5, 2), (6, 3)].map(|(id, i)| {
        let file = parse_nexus_share_pin(files[i].clone(), "payday3", 12, id)
            .unwrap()
            .map(PreviewFile::try_from)
            .transpose()
            .unwrap();
        ((12, id), Ok(file))
    });
    let choices = parse_nexus_share_choices(json!({"files":files}), "payday3", 12)
        .unwrap()
        .into_iter()
        .map(PreviewFile::try_from)
        .collect::<Result<_, _>>()
        .unwrap();
    Catalog {
        nexus_pins: HashMap::from(pins),
        nexus_choices: HashMap::from([(12, Ok(choices))]),
        ..Catalog::default()
    }
}

#[test]
fn nexus_keeps_exact_current_and_archived_pins() {
    let catalog = nexus_catalog();
    let result = preview(
        vec![
            nexus_member(Some(3), "Old.pak"),
            nexus_member(Some(6), "New.pak"),
        ],
        &catalog,
    );
    for (i, id, version) in [(0, 3, "1.2"), (1, 6, "2")] {
        let row = &result["rows"][i];
        assert_eq!(row["resolution"]["status"], "nexusDownload");
        assert_eq!(row["resolution"]["file"]["id"], id);
        assert_eq!(row["sharedVersion"], version);
        assert_eq!(row["installVersion"], version);
    }
}

#[test]
fn missing_or_page_only_nexus_pin_offers_only_current_files() {
    let mut catalog = nexus_catalog();
    catalog.nexus_pins.insert((12, 99), Ok(None));
    for id in [None, Some(5), Some(99)] {
        let result = preview(vec![nexus_member(id, "New HUD")], &catalog);
        let row = &result["rows"][0];
        assert_eq!(row["resolution"]["status"], "needsChoice");
        assert_eq!(
            row["resolution"]["candidates"],
            json!([{"id":6,"name":"New HUD","version":"2","size":3072,"label":null}])
        );
        assert!(row["sharedVersion"].is_null() && row["installVersion"].is_null());
    }
}

#[test]
fn signed_out_nexus_rows_leave_workshop_rows_ready() {
    let mut catalog = workshop(variants());
    catalog
        .nexus_pins
        .insert((12, 3), Err(LookupIssue::NexusSignInRequired));
    catalog
        .nexus_choices
        .insert(12, Err(LookupIssue::NexusSignInRequired));
    let result = preview(
        vec![
            nexus_member(Some(3), "A"),
            nexus_member(None, "B"),
            workshop_member(json!({"fileId":89900}), "C"),
        ],
        &catalog,
    );
    assert_eq!(
        result["rows"][0]["resolution"]["status"],
        "nexusSignInRequired"
    );
    assert_eq!(result["totals"]["nexusSignInRequired"], 2);
    assert_eq!(result["totals"]["ready"], 1);
    assert_eq!(result["failedSources"], json!([]));
}

#[test]
fn one_failed_lookup_is_local_and_a_whole_source_failure_is_reported() {
    let mut catalog = workshop(variants());
    catalog
        .workshop
        .insert(9, Err(LookupIssue::Failed("request timed out".into())));
    let failed = member(json!({"source":"modworkshop","modId":9}), "A");
    let result = preview(
        vec![
            failed.clone(),
            workshop_member(json!({"fileId":89900}), "C"),
        ],
        &catalog,
    );
    assert_eq!(
        result["rows"][0]["resolution"],
        json!({"status":"lookupFailed","reason":"request timed out"})
    );
    assert_eq!(result["totals"]["ready"], 1);
    assert_eq!(result["failedSources"], json!([]));
    assert_eq!(
        preview(vec![failed], &catalog)["failedSources"],
        json!(["modworkshop"])
    );
}

#[test]
fn totals_count_member_rows_and_distinct_downloads() {
    let mut catalog = nexus_catalog();
    catalog.workshop = workshop(variants()).workshop;
    let result = preview(
        vec![
            nexus_member(Some(3), "Dark"),
            nexus_member(Some(3), "Light"),
            nexus_member(None, "Page"),
            workshop_member(json!({"fileId":89900}), "Steam.pak"),
            workshop_member(json!({"fileId":89900}), "Second.pak"),
        ],
        &catalog,
    );
    assert_eq!(
        result["totals"],
        json!({"ready":2,"nexusDownload":2,"needsChoice":1,
       "unavailable":0,"lookupFailed":0,"nexusSignInRequired":0,"knownDownloadBytes":1099,"nexusDownloadsNeeded":1})
    );
}

#[test]
fn loose_loader_preview_recognizes_live_and_parked_hooks_on_the_target_copy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let game_path = root.to_str().unwrap();
    let mut input = share(vec![]);
    input["gameId"] = json!("pd2");
    input["loaders"] = json!(["superblt"]);
    let share = super::super::parse(&input.to_string()).unwrap();
    let present = || preview_loaders(&share, game_path, None).unwrap()[0].already_present;
    assert!(!present());
    fs::write(root.join("WSOCK32.dll"), []).unwrap();
    assert!(present());
    let parked = root.join(".modrex/loaders/superblt");
    fs::create_dir_all(&parked).unwrap();
    fs::rename(root.join("WSOCK32.dll"), parked.join("WSOCK32.dll")).unwrap();
    fs::write(
        root.join(".modrex/loaders/left-out.json"),
        json!({"schemaVersion":1,"loaders":[{"id":"superblt","files":["WSOCK32.dll"]}]})
            .to_string(),
    )
    .unwrap();
    assert!(present());
    fs::remove_file(parked.join("WSOCK32.dll")).unwrap();
    assert!(!present());
}

#[tokio::test]
async fn preview_command_revalidates_file_and_paste_before_lookup() {
    let mut input = share(vec![workshop_member(json!({"fileId":73}), "HUD.pak")]);
    input["members"][0]["archiveMember"] = json!("../bad");
    let file = input.to_string();
    for text in [super::super::encode(file.as_bytes()).unwrap(), file] {
        let error = from_text::<()>(text, "pd3".into(), async |_| {
            panic!("invalid input reached lookup")
        })
        .await
        .unwrap_err();
        assert!(error.contains("relative archive member"), "{error}");
    }
}

#[tokio::test]
async fn preview_command_refuses_another_game_before_lookup() {
    let input = share(vec![]).to_string();
    let error = from_text::<()>(input, "pd2".into(), async |_| {
        panic!("wrong game reached lookup")
    })
    .await
    .unwrap_err();
    assert!(error.contains("for pd3") && error.contains("target game is pd2"));
}

#[test]
fn import_accepts_only_choices_offered_by_the_current_resolution() {
    let member = workshop_member(json!({}), "Unknown.pak");
    let share = super::super::parse(&share(vec![member]).to_string()).unwrap();
    let cfg = super::super::engine_for_game("pd3").unwrap();
    let rows = |files, key: &str, id| {
        let preview = resolve(&share, cfg, &workshop(files), vec![]);
        super::super::import::resolve_rows(&share, preview, [(key.to_owned(), id)].into())
    };
    assert!(rows(variants(), "1", 89916).is_ok());
    assert!(rows(variants(), "1", 1).is_err());
    assert!(rows(variants(), "2", 89916).is_err());
    assert!(rows(json!([{"id":89916,"name":"Only"}]), "1", 89916).is_err());
}

#[test]
fn import_accepts_only_choices_among_a_rows_candidates() {
    let rows = |choices: &[(&str, u32)]| {
        let members = vec![
            workshop_member(json!({}), "Other.pak"),
            workshop_member(json!({"fileId":89900}), "Steam.pak"),
        ];
        let share = super::super::parse(&share(members).to_string()).unwrap();
        let cfg = super::super::engine_for_game(&share.game_id).unwrap();
        let preview = resolve(&share, cfg, &workshop(variants()), vec![]);
        let choices = choices.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        super::super::import::resolve_rows(&share, preview, choices).map(|rows| rows.len())
    };
    assert_eq!(rows(&[]), Ok(2));
    assert_eq!(rows(&[("1", 89898)]), Ok(2));
    assert!(rows(&[("1", 12345)])
        .unwrap_err()
        .contains("not a candidate"));
    assert!(rows(&[("2", 89898)])
        .unwrap_err()
        .contains("does not need a file choice"));
    assert!(rows(&[("3", 89898)])
        .unwrap_err()
        .contains("unknown profile member"));
}

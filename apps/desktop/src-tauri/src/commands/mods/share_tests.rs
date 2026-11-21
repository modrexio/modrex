use super::*;
use crate::commands::mods::{
    paths::get_state_path,
    profiles::{share_snapshot, Install, ParkedMod, ProfileMember, ProfileStore},
    state::save_state,
    types::{ModFolder, ModsState},
};
use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;
use uuid::Uuid;

fn example() -> Value {
    json!({
        "format": FORMAT, "schemaVersion": 1, "gameId": "pd3", "profileName": "Stealth",
        "root": [{"folder": 1}],
        "folders": [{"name":"HUD","children":[{"mod":1}]}],
        "members": [{
            "file":{"source":"modworkshop","modId":42,"fileId":73,"fileName":"Minimal HUD","label":"MAIN","version":"1.2"},
            "enabled":false,"folder":1,"priority":2,"archiveMember":"dark/HUD.pak",
            "target":"paks","installedName":"HUD.pak"
        }],
        "loaders":[]
    })
}

fn rejects(edit: impl FnOnce(&mut Value), reason: &str) {
    let mut share = example();
    edit(&mut share);
    let err = parse(&share.to_string()).unwrap_err();
    assert!(err.contains(reason), "{err}");
}

#[test]
fn round_trips_file_text_and_paste_code() {
    let input = example();
    let file = input.to_string();
    let code = encode(file.as_bytes()).unwrap();
    assert!(code.starts_with(CODE_PREFIX) && !code.contains('='));
    let share = parse(&file).unwrap();
    assert_eq!(parse(&code).unwrap(), share);
    assert_eq!(serde_json::to_value(share).unwrap(), input);
}

#[test]
fn rejects_unknown_format() {
    rejects(|s| s["format"] = json!("other"), "format");
}

#[test]
fn rejects_unknown_schema_version() {
    rejects(|s| s["schemaVersion"] = json!(2), "schema version");
}

#[test]
fn rejects_oversized_file_text() {
    assert!(parse(&" ".repeat(MAX_JSON_BYTES + 1))
        .unwrap_err()
        .contains("JSON exceeds"));
}

#[test]
fn rejects_oversized_code_before_base64_decode() {
    let code = format!(
        "{CODE_PREFIX}{}",
        "!".repeat(MAX_CODE_BYTES + 1 - CODE_PREFIX.len())
    );
    assert!(parse(&code).unwrap_err().contains("code exceeds"));
}

#[test]
fn stops_an_inflate_bomb_at_the_json_limit() {
    let mut bytes = example().to_string().into_bytes();
    bytes.resize(MAX_JSON_BYTES * 2, b' ');
    let code = encode(&bytes).unwrap();
    assert!(code.len() < MAX_JSON_BYTES / 100);
    assert!(parse(&code)
        .unwrap_err()
        .contains("Inflated profile exceeds"));
}

#[test]
fn rejects_invalid_code_and_incomplete_or_trailing_deflate() {
    assert!(parse("MRX:/+==").is_err());
    let code = encode(example().to_string().as_bytes()).unwrap();
    let mut bytes = URL_SAFE_NO_PAD.decode(&code[CODE_PREFIX.len()..]).unwrap();
    for data in [&bytes[..bytes.len() - 1], &[]] {
        assert!(parse(&format!("{CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(data))).is_err());
    }
    bytes.push(0);
    assert!(parse(&format!("{CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))).is_err());
}

#[test]
fn rejects_too_many_members() {
    rejects(
        |s| s["members"] = json!(vec![s["members"][0].clone(); MAX_MEMBERS + 1]),
        "Too many",
    );
}

#[test]
fn rejects_too_many_folders() {
    rejects(
        |s| s["folders"] = json!(vec![s["folders"][0].clone(); MAX_FOLDERS + 1]),
        "Too many",
    );
}

#[test]
fn rejects_excess_folder_depth() {
    rejects(
        |s| {
            s["folders"] = json!((1..=MAX_DEPTH + 1)
                .map(|key| json!({
                    "name":"nested", "children":[{"folder":key + 1}]
                }))
                .collect::<Vec<_>>());
        },
        "depth limit",
    );
}

#[test]
fn rejects_oversized_strings() {
    for field in [
        "/profileName",
        "/folders/0/name",
        "/members/0/installedName",
        "/members/0/file/fileName",
        "/members/0/file/label",
        "/members/0/file/version",
    ] {
        rejects(
            |s| *s.pointer_mut(field).unwrap() = json!("a".repeat(MAX_TEXT_BYTES + 1)),
            "oversized",
        );
    }
    rejects(
        |s| s["members"][0]["archiveMember"] = json!("x".repeat(MAX_SELECTOR_BYTES + 1)),
        "oversized",
    );
}

#[test]
fn rejects_empty_names_and_control_characters() {
    rejects(|s| s["profileName"] = json!(" "), "text");
    rejects(|s| s["folders"][0]["name"] = json!("HUD\n"), "text");
}

#[test]
fn rejects_unknown_game_source_and_unbound_source() {
    rejects(|s| s["gameId"] = json!("none"), "unknown game");
    rejects(
        |s| s["members"][0]["file"]["source"] = json!("local"),
        "unknown variant",
    );
    rejects(|s| s["gameId"] = json!("ron"), "catalog reference");
}

#[test]
fn rejects_nonpositive_and_out_of_range_catalog_ids() {
    for source in ["modworkshop", "nexus"] {
        for key in ["modId", "fileId"] {
            for bad in [0, -1, i64::from(u32::MAX) + 1] {
                rejects(
                    |s| {
                        let file = &mut s["members"][0]["file"];
                        *file = json!({"source":source,"modId":1,"fileId":1});
                        file[key] = json!(bad);
                    },
                    if bad == 0 {
                        "catalog reference"
                    } else {
                        "Invalid profile JSON"
                    },
                );
            }
        }
    }
}

#[test]
fn rejects_absolute_drive_unc_and_traversal_selectors() {
    for bad in [
        "/root/file",
        r"\root\file",
        "C:file",
        "C:/dir/file",
        r"\\host\share",
        "//host/share",
        "../entry",
        "dir/../entry",
        "dir/.. /entry",
        r"dir\..\entry",
        "http://host/file",
    ] {
        rejects(
            |s| s["members"][0]["archiveMember"] = json!(bad),
            "archive member",
        );
    }
}

#[test]
fn rejects_paths_in_file_and_host_set_names() {
    for field in ["installedName", "hostPackSet"] {
        rejects(
            |s| s["members"][0][field] = json!(r"other\dir"),
            "single name",
        );
    }
    rejects(
        |s| s["members"][0]["file"]["fileName"] = json!("dir/file"),
        "single name",
    );
}

#[test]
fn rejects_unknown_target_and_invalid_loose_loaders() {
    rejects(
        |s| s["members"][0]["target"] = json!("elsewhere"),
        "Unknown install target",
    );
    for loaders in [
        json!(["pdml"]),
        json!(["superblt"]),
        json!(["ue4ss", "ue4ss"]),
    ] {
        rejects(|s| s["loaders"] = loaders, "loose loader");
    }
}

#[test]
fn rejects_duplicate_members_even_with_different_labels_or_state() {
    rejects(
        |s| {
            let mut copy = s["members"][0].clone();
            copy["enabled"] = json!(true);
            copy["file"]["label"] = json!("another label");
            copy["installedName"] = json!("Renamed.pak");
            copy["archiveMember"] = json!("./dark/HUD.pak");
            s["members"].as_array_mut().unwrap().push(copy);
        },
        "Duplicate profile member",
    );
}

#[test]
fn allows_distinct_entries_in_the_same_catalog_file() {
    let mut s = example();
    let mut copy = s["members"][0].clone();
    copy["archiveMember"] = json!("light/HUD.pak");
    s["members"].as_array_mut().unwrap().push(copy);
    s["folders"][0]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mod":2}));
    assert!(parse(&s.to_string()).is_ok());
}

#[test]
fn rejects_folder_cycles_including_disconnected_cycles() {
    rejects(
        |s| s["folders"][0]["children"] = json!([{"folder":1}]),
        "folder cycle",
    );
    rejects(
        |s| {
            s["root"] = json!([]);
            s["folders"][0]["children"] = json!([{"folder":1}]);
        },
        "unreachable",
    );
}

#[test]
fn rejects_missing_repeated_and_misplaced_children() {
    for (children, reason) in [
        (json!([{"mod":2}]), "Unknown member"),
        (json!([{"folder":0}]), "Unknown folder"),
        (json!([{"mod":1},{"mod":1}]), "Repeated"),
        (json!([]), "unreachable"),
    ] {
        rejects(|s| s["folders"][0]["children"] = children, reason);
    }
    rejects(|s| s["members"][0]["folder"] = Value::Null, "misplaced");
}

#[test]
fn rejects_private_fields_and_source_specific_field_mismatches() {
    rejects(
        |s| s["members"][0]["installId"] = json!("private"),
        "unknown field",
    );
    rejects(
        |s| s["members"][0]["file"]["url"] = json!("https://example.com"),
        "unknown field",
    );
    rejects(
        |s| s["members"][0]["file"]["source"] = json!("nexus"),
        "unknown field",
    );
}

fn workshop(name: &str, file_id: i64) -> InstalledMod {
    InstalledMod {
        uid: file_id.to_string(),
        filename: name.into(),
        source: "modworkshop".into(),
        remote_id: Some("42".into()),
        file_id: Some(file_id),
        version: "1.2".into(),
        ..InstalledMod::default()
    }
}

fn member(record: &InstalledMod, folder: Option<&str>, priority: i64) -> ProfileMember {
    ProfileMember {
        install_id: record.install_id.clone(),
        enabled: true,
        folder_id: folder.map(str::to_owned),
        priority: Some(priority),
    }
}

fn folder(id: &str, parent: Option<&str>, priority: i64) -> ModFolder {
    ModFolder {
        id: id.into(),
        disk_name: format!("private-{id}"),
        display_name: format!("Folder {priority}"),
        priority,
        parent_id: parent.map(str::to_owned),
    }
}

#[test]
fn exports_only_portable_fields_of_a_workshop_install() {
    let record = InstalledMod {
        workshop_file_name: Some("Minimal HUD".into()),
        workshop_file_label: Some("MAIN".into()),
        archive_member: Some("dark/HUD.pak".into()),
        author: Some("private author".into()),
        thumbnail_url: Some("https://example.com/private".into()),
        sha256: Some("private digest".into()),
        placed_sha256: Some("private digest".into()),
        ..workshop("002_HUD.pak.disabled", 73)
    };
    let profile = Profile {
        pending: Vec::new(),
        id: Uuid::new_v4().to_string(),
        name: "Stealth".into(),
        members: vec![ProfileMember {
            enabled: false,
            ..member(&record, Some("local-folder"), 2)
        }],
        folders: vec![ModFolder {
            display_name: "HUD".into(),
            ..folder("local-folder", None, 1)
        }],
        loaders: Some(vec![]),
        ..Profile::default()
    };
    let result = export(engine_for_game("pd3").unwrap(), &profile, &[record]).unwrap();
    let expected = parse(&example().to_string()).unwrap();
    assert_eq!(result.file_text, serde_json::to_string(&expected).unwrap());
    assert_eq!(parse(&result.paste_code).unwrap(), expected);
}

#[test]
fn exports_inactive_live_and_parked_members_in_saved_mixed_order() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let state = get_state_path(path, cfg);
    let install = Install {
        game_path: path,
        cfg,
        state_path: &state,
        launcher: None,
    };
    let store = ProfileStore::new(path);
    let parked = InstalledMod {
        workshop_file_name: Some("Minimal HUD".into()),
        workshop_file_label: Some("MAIN".into()),
        ..workshop("005_HUD.pak.disabled", 73)
    };
    let other = InstalledMod {
        archive_member: Some("light/HUD.pak".into()),
        ..workshop("HUD.pak", 74)
    };
    let nexus = InstalledMod {
        source: "nexus".into(),
        remote_id: Some("27".into()),
        file_remote_id: Some("89".into()),
        file_id: Some(999),
        filename: "MyPlugin".into(),
        location: Some("plugins".into()),
        ..InstalledMod::default()
    };
    let local = InstalledMod {
        file_id: Some(456),
        ..InstalledMod::default()
    };
    let page_only = InstalledMod {
        source: "nexus".into(),
        remote_id: Some("99".into()),
        file_id: Some(91),
        filename: "Page.pak".into(),
        ..InstalledMod::default()
    };
    let stored = |stored: &str, record: &InstalledMod| ParkedMod {
        stored: stored.into(),
        record: record.clone(),
    };
    let mut profile = Profile {
        id: Uuid::new_v4().to_string(),
        name: "Parked setup".into(),
        members: vec![
            ProfileMember {
                enabled: false,
                ..member(&parked, None, 3)
            },
            member(&nexus, None, 1),
            member(&local, None, 6),
            member(&other, Some("inner"), 1),
            member(&page_only, None, 7),
        ],
        folders: vec![folder("outer", None, 2), folder("inner", Some("outer"), 1)],
        loaders: Some(vec!["ue4ss".into()]),
        parked: vec![
            stored("HUD.pak", &parked),
            stored("HUD (2).pak", &other),
            stored("local", &local),
            stored("Page.pak", &page_only),
        ],
        ..Profile::default()
    };
    store.place(&mut profile).unwrap();
    let metadata = tmp.path().join(".modrex");
    let marker = json!({"schemaVersion":1, "activeProfile":Uuid::new_v4().to_string()}).to_string();
    fs::write(metadata.join("install.json"), &marker).unwrap();
    let profile_file = profile.dir.join("profile.json");
    let profile_json = fs::read_to_string(&profile_file).unwrap();
    let parked_file = profile.dir.join("HUD.pak");
    fs::write(&parked_file, b"parked bytes").unwrap();
    save_state(
        &state,
        &ModsState {
            mods: vec![nexus],
            folders: vec![],
        },
    )
    .unwrap();
    let before = fs::read(&state).unwrap();
    let (saved, records) = share_snapshot(&install, &profile.id).unwrap();
    let result = export(cfg, &saved, &records).unwrap();
    assert_eq!(result.left_out, 1);
    let share = parse(&result.file_text).unwrap();
    assert_eq!(parse(&result.paste_code).unwrap(), share);
    assert_eq!(
        serde_json::to_value(share).unwrap(),
        json!({
            "format":FORMAT,"schemaVersion":1,"gameId":"pd3","profileName":"Parked setup",
            "root":[{"mod":4},{"mod":1},{"folder":1},{"mod":2}],
            "folders":[{"name":"Folder 2","children":[{"folder":2}]},{"name":"Folder 1","children":[{"mod":3}]}],
            "members":[
                {"file":{"source":"modworkshop","modId":42,"fileId":73,"fileName":"Minimal HUD","label":"MAIN","version":"1.2"},"enabled":false,"folder":null,"priority":3,"target":"paks","installedName":"HUD.pak"},
                {"file":{"source":"nexus","modId":27,"fileId":89},"enabled":true,"folder":null,"priority":1,"target":"plugins","installedName":"MyPlugin"},
                {"file":{"source":"modworkshop","modId":42,"fileId":74,"version":"1.2"},"enabled":true,"folder":2,"priority":1,"archiveMember":"light/HUD.pak","target":"paks","installedName":"HUD.pak"},
                {"file":{"source":"nexus","modId":99},"enabled":true,"folder":null,"priority":7,"target":"paks","installedName":"Page.pak"}
            ],"loaders":["ue4ss"]
        })
    );
    assert_eq!(fs::read(&parked_file).unwrap(), b"parked bytes");
    assert_eq!(fs::read(&state).unwrap(), before);
    assert_eq!(fs::read_to_string(&profile_file).unwrap(), profile_json);
    assert_eq!(
        fs::read_to_string(metadata.join("install.json")).unwrap(),
        marker
    );
}

#[test]
fn exports_active_members_folders_and_loaders_from_live_state() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    let state = get_state_path(path, cfg);
    let install = Install {
        game_path: path,
        cfg,
        state_path: &state,
        launcher: None,
    };
    let store = ProfileStore::new(path);
    let mut profile = Profile {
        id: Uuid::new_v4().to_string(),
        name: "Live".into(),
        loaders: Some(vec![]),
        ..Profile::default()
    };
    store.place(&mut profile).unwrap();
    fs::write(
        tmp.path().join(".modrex/install.json"),
        json!({"schemaVersion":1, "activeProfile":profile.id}).to_string(),
    )
    .unwrap();
    fs::write(tmp.path().join("WSOCK32.dll"), b"hook").unwrap();
    let pack = InstalledMod {
        location: Some("host:17160:Assets".into()),
        remote_id: None,
        id: 42,
        ..workshop("1980_Night", 12)
    };
    save_state(
        &state,
        &ModsState {
            mods: vec![pack],
            folders: vec![folder("empty", None, 4)],
        },
    )
    .unwrap();
    let (live, records) = share_snapshot(&install, &profile.id).unwrap();
    let result = export(cfg, &live, &records).unwrap();
    let share = parse(&result.file_text).unwrap();
    assert_eq!(
        share.members[0].host_pack_set.as_deref(),
        Some("1980_Night")
    );
    assert_eq!(share.members[0].installed_name, "1980_Night");
    assert_eq!(share.folders[0].name, "Folder 4");
    assert_eq!(share.loaders, Some(vec!["superblt".into()]));
    assert!(store.get(&profile.id).unwrap().members.is_empty());
}

#[test]
fn shares_mods_matched_only_to_their_page_without_a_file_id() {
    let page_only = InstalledMod {
        install_id: "page-only".into(),
        file_id: None,
        ..workshop("PageOnly.pak", 0)
    };
    let link_only = InstalledMod {
        install_id: "link-only".into(),
        remote_id: Some("43".into()),
        ..workshop("LinkOnly.pak", -7)
    };
    let nexus = InstalledMod {
        install_id: "nexus-page".into(),
        filename: "NexusPage.pak".into(),
        source: "nexus".into(),
        remote_id: Some("27".into()),
        ..InstalledMod::default()
    };
    let profile = Profile {
        pending: Vec::new(),
        id: Uuid::new_v4().to_string(),
        name: "Pages".into(),
        members: [&page_only, &link_only, &nexus]
            .into_iter()
            .map(|r| member(r, None, 1))
            .collect(),
        folders: vec![],
        loaders: None,
        ..Profile::default()
    };
    let records = [page_only, link_only, nexus];
    let result = export(engine_for_game("pd3").unwrap(), &profile, &records).unwrap();
    assert_eq!(result.left_out, 0);
    let share: Value = serde_json::from_str(&result.file_text).unwrap();
    let files: Vec<_> = share["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["file"].clone())
        .collect();
    assert_eq!(
        files,
        [
            json!({"source":"modworkshop","modId":42,"version":"1.2"}),
            json!({"source":"modworkshop","modId":43,"version":"1.2"}),
            json!({"source":"nexus","modId":27}),
        ]
    );
    assert_eq!(
        parse(&result.file_text).unwrap(),
        parse(&result.paste_code).unwrap()
    );
}

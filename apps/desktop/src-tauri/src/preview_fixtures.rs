//! Fixtures go through the app's own parsers so the browser preview never sees a shape
//! the renderer would not get over IPC.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::commands::domain::{FilePage, LinkPage, ModDetail};

const FIXTURES_DIR: &str = "../src/renderer/preview/fixtures";
const LISTING_LIMIT: u32 = 24;

struct Snapshot {
    game_id: &'static str,
    workshop_id: u32,
}

#[derive(Serialize)]
struct ModRecord {
    detail: ModDetail,
    files: FilePage,
    links: LinkPage,
}

const SNAPSHOTS: &[Snapshot] = &[
    Snapshot {
        game_id: "pd3",
        workshop_id: 853,
    },
    Snapshot {
        game_id: "pd2",
        workshop_id: 1,
    },
    Snapshot {
        game_id: "pdth",
        workshop_id: 2,
    },
    Snapshot {
        game_id: "cb",
        workshop_id: 857,
    },
    Snapshot {
        game_id: "raid",
        workshop_id: 543,
    },
];

async fn get(path: &str, query: &[(&str, &str)]) -> Value {
    let params = query.iter().map(|(k, v)| (*k, v.to_string())).collect();
    crate::commands::api::api_get_as("modrex-preview-fixtures", path, params)
        .await
        .unwrap_or_else(|e| panic!("fixture request {path} failed: {e}"))
}

fn write<T: Serialize>(name: &str, value: &T) {
    let path = std::path::PathBuf::from(format!("{FIXTURES_DIR}/{name}.json"));
    let dir = path.parent().expect("fixture path has a parent");
    std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("cannot create {}: {e}", dir.display()));
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    value
        .serialize(&mut serde_json::Serializer::with_formatter(
            &mut text, formatter,
        ))
        .expect("fixture serializes");
    text.push(b'\n');
    std::fs::write(&path, text).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

#[doc(hidden)]
pub fn export_preview_fixtures() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");
    tauri::async_runtime::block_on(async {
        write("loaders", &crate::commands::loaders::list_loaders());
        write("sources", &crate::commands::sources::list_sources());
        for snapshot in SNAPSHOTS {
            let folders = crate::commands::mods::list_mod_folders(snapshot.game_id.to_string())
                .unwrap_or_else(|e| panic!("{} mod folders: {e}", snapshot.game_id));
            write(&format!("{}/mod-folders", snapshot.game_id), &folders);
            let game = format!("/games/{}", snapshot.workshop_id);
            let limit = LISTING_LIMIT.to_string();
            let listing = get(
                &format!("{game}/mods"),
                &[("limit", limit.as_str()), ("sort", "bumped_at")],
            )
            .await;
            let page = crate::commands::domain::parse_mod_page(listing)
                .unwrap_or_else(|e| panic!("{} listing: {e}", snapshot.game_id));
            let mut records = BTreeMap::new();
            for summary in &page.data {
                let id = summary.id;
                let detail = crate::commands::domain::parse_mod_detail(
                    get(&format!("/mods/{id}"), &[]).await,
                )
                .unwrap_or_else(|e| panic!("mod {id} detail: {e}"));
                let files = crate::commands::domain::parse_file_page(
                    get(&format!("/mods/{id}/files"), &[]).await,
                )
                .unwrap_or_else(|e| panic!("mod {id} files: {e}"));
                let links = crate::commands::domain::parse_link_page(
                    get(&format!("/mods/{id}/links"), &[]).await,
                )
                .unwrap_or_else(|e| panic!("mod {id} links: {e}"));
                records.insert(
                    id,
                    ModRecord {
                        detail,
                        files,
                        links,
                    },
                );
            }
            write(&format!("{}/mods", snapshot.game_id), &page);
            write(&format!("{}/mod-records", snapshot.game_id), &records);
            if crate::games::discovered()
                .iter()
                .any(|(id, def)| *id == snapshot.game_id && !def.news.is_empty())
            {
                let news = crate::commands::news::fetch_news_page(snapshot.game_id.to_string(), 1)
                    .await
                    .unwrap_or_else(|e| panic!("{} news: {e}", snapshot.game_id));
                write(&format!("{}/news", snapshot.game_id), &news);
            }
            write(
                &format!("{}/categories", snapshot.game_id),
                &get(&format!("{game}/categories"), &[]).await,
            );
            write(
                &format!("{}/tags", snapshot.game_id),
                &get(&format!("{game}/tags"), &[("type", "mod"), ("global", "1")]).await,
            );
        }
    });
}

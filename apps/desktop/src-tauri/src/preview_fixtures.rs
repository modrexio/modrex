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

const SNAPSHOTS: &[Snapshot] = &[Snapshot {
    game_id: "pd3",
    workshop_id: 853,
}];

async fn get(path: &str, query: &[(&str, &str)]) -> Value {
    let url =
        reqwest::Url::parse_with_params(&format!("{}{path}", crate::commands::api::BASE), query)
            .unwrap_or_else(|e| panic!("bad fixture url {path}: {e}"));
    crate::commands::api::http_client()
        .get(url.clone())
        .header("User-Agent", "modrex-preview-fixtures")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .unwrap_or_else(|e| panic!("fixture request {url} failed: {e}"))
        .json()
        .await
        .unwrap_or_else(|e| panic!("fixture response {url} is not json: {e}"))
}

fn write<T: Serialize>(name: &str, value: &T) {
    let path = std::path::PathBuf::from(format!("{FIXTURES_DIR}/{name}.json"));
    let dir = path.parent().expect("fixture path has a parent");
    std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("cannot create {}: {e}", dir.display()));
    let text = serde_json::to_string_pretty(value).expect("fixture serializes");
    std::fs::write(&path, text + "\n")
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
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

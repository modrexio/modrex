//! Fixtures go through the app's own parsers so the browser preview never sees a shape
//! the renderer would not get over IPC.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::commands::domain::{FilePage, LinkPage, ModDetail, ModPage, PageMeta};
use crate::game_package::SourceBinding;

const FIXTURES_DIR: &str = "../src/renderer/preview/fixtures";
const LISTING_LIMIT: u32 = 24;

#[derive(Serialize)]
struct ModRecord {
    detail: ModDetail,
    files: FilePage,
    links: LinkPage,
}

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

fn write_empty_workshop_fixtures(game_id: &str) {
    write(
        &format!("{game_id}/mods"),
        &ModPage {
            data: Vec::new(),
            meta: PageMeta {
                current_page: 1,
                last_page: 1,
                per_page: i64::from(LISTING_LIMIT),
                total: 0,
            },
        },
    );
    write(
        &format!("{game_id}/mod-records"),
        &BTreeMap::<i64, ModRecord>::new(),
    );
    write(&format!("{game_id}/categories"), &Vec::<Value>::new());
    write(&format!("{game_id}/tags"), &Vec::<Value>::new());
}

#[doc(hidden)]
pub fn export_preview_fixtures() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");
    tauri::async_runtime::block_on(async {
        write("loaders", &crate::commands::loaders::list_loaders());
        write("sources", &crate::commands::sources::list_sources());
        for (game_id, package) in crate::games::discovered() {
            let folders = crate::commands::mods::list_mod_folders(game_id.to_string())
                .unwrap_or_else(|e| panic!("{game_id} mod folders: {e}"));
            write(&format!("{game_id}/mod-folders"), &folders);
            if !package.news.is_empty() {
                let news = crate::commands::news::fetch_news_page(game_id.to_string(), 1)
                    .await
                    .unwrap_or_else(|e| panic!("{game_id} news: {e}"));
                write(&format!("{game_id}/news"), &news);
            }
            let workshop_id = package.sources.iter().find_map(|source| match source {
                SourceBinding::ModWorkshop { game_id } => Some(game_id),
                SourceBinding::Nexus { .. } => None,
            });
            let Some(workshop_id) = workshop_id else {
                write_empty_workshop_fixtures(game_id);
                continue;
            };
            let game = format!("/games/{workshop_id}");
            let limit = LISTING_LIMIT.to_string();
            let listing = get(
                &format!("{game}/mods"),
                &[("limit", limit.as_str()), ("sort", "bumped_at")],
            )
            .await;
            let page = crate::commands::domain::parse_mod_page(listing)
                .unwrap_or_else(|e| panic!("{game_id} listing: {e}"));
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
            write(&format!("{game_id}/mods"), &page);
            write(&format!("{game_id}/mod-records"), &records);
            write(
                &format!("{game_id}/categories"),
                &get(&format!("{game}/categories"), &[]).await,
            );
            write(
                &format!("{game_id}/tags"),
                &get(&format!("{game}/tags"), &[("type", "mod"), ("global", "1")]).await,
            );
        }
    });
}

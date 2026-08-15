//! Fixtures are reduced from real marker files: the malformed ones are malformed the way the
//! ecosystem actually is.

use super::*;
use crate::commands::mods::identity::LocalSignals;
use tempfile::TempDir;

fn signals_of(marker: &str, body: &str) -> LocalSignals {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join(marker), body).unwrap();
    local_signals(dir.path())
}

#[test]
fn reads_a_plain_mod_txt() {
    let signals = signals_of(
        "mod.txt",
        r#"{ "name": "Celer", "author": "TdlQ", "version": "55" }"#,
    );
    assert_eq!(signals.declared_name.as_deref(), Some("Celer"));
    assert_eq!(signals.declared_author.as_deref(), Some("TdlQ"));
    assert_eq!(signals.declared_version.as_deref(), Some("55"));
}

#[test]
fn tolerates_the_json_real_mod_txt_files_are_not() {
    // Trailing commas, a comment, a BOM and CRLF all appear in shipped mods, and around one
    // file in thirteen fails a strict parse. Their identity must survive anyway.
    let signals = signals_of(
        "mod.txt",
        "\u{feff}{\r\n\t// what this mod is\r\n\t\"name\" : \"Please, Go There\",\r\n\t\"author\" : \"TdlQ\",\r\n}\r\n",
    );
    assert_eq!(signals.declared_name.as_deref(), Some("Please, Go There"));
    assert_eq!(signals.declared_author.as_deref(), Some("TdlQ"));
}

#[test]
fn author_credits_do_not_leak_into_the_author() {
    let signals = signals_of(
        "mod.txt",
        "{\"name\":\"Keepers\",\"author\":\"TdlQ\\n    russian translation by chrom[K]a\"}",
    );
    assert_eq!(signals.declared_author.as_deref(), Some("TdlQ"));
}

#[test]
fn display_name_never_wins_over_the_mods_own_name() {
    let signals = signals_of(
        "mod.txt",
        r#"{ "updates": [ { "display_name": "Simple Mod Updater", "identifier": "x" } ], "name": "Iter" }"#,
    );
    assert_eq!(signals.declared_name.as_deref(), Some("Iter"));
}

#[test]
fn a_download_url_naming_this_mod_beats_a_shared_updater_identifier() {
    // The whole pd2mods.z77.fr family declares the identifier of the updater tool they share,
    // so twelve distinct mods would otherwise collapse onto one key.
    let signals = signals_of(
        "mod.txt",
        r#"{
            "name": "Celer",
            "simple_update_url": "http://pd2mods.z77.fr/update/Celer.zip",
            "updates": [ { "identifier": "SimpleModUpdater",
                           "host": { "meta": "http://pd2mods.z77.fr/meta/SimpleModUpdater" } } ]
        }"#,
    );
    assert_eq!(
        signals.updater,
        Some(("pd2mods.z77.fr".to_string(), "Celer".to_string()))
    );
}

#[test]
fn an_updater_host_of_its_own_keeps_its_identifier() {
    let signals = signals_of(
        "mod.txt",
        r#"{ "name": "Bot Weapons and Equipment",
             "updates": [ { "identifier": "pd2-bot-weapons",
                            "host": { "meta": "https://updates.hoppip.at/pd2-bot-weapons" } } ] }"#,
    );
    assert_eq!(
        signals.updater,
        Some((
            "updates.hoppip.at".to_string(),
            "pd2-bot-weapons".to_string()
        ))
    );
}

#[test]
fn an_updates_entry_without_a_host_is_a_dead_service_record() {
    // paydaymods.com stopped operating in February 2020. SuperBLT still parses these so
    // dependency declarations resolve, and the identifier stays meaningful in that namespace.
    let signals = signals_of(
        "mod.txt",
        r#"{ "name": "Silent Assassin", "author": "DrTachyon",
             "updates": [ { "revision": 2.93, "identifier": "silentassassin" } ] }"#,
    );
    assert_eq!(
        signals.legacy,
        Some(("paydaymods".to_string(), "silentassassin".to_string()))
    );
    assert_eq!(signals.updater, None);
}

#[test]
fn a_forge_hosted_updater_resolves_to_its_repository() {
    let signals = signals_of(
        "mod.txt",
        r#"{ "name": "Carry Stacker Reloaded",
             "updates": [ { "identifier": "carry-stacker-reloaded", "host": { "meta":
               "https://github.com/enragedpixel/Carry-Stacker-Reloaded/releases/latest/download/meta.json" } } ] }"#,
    );
    assert_eq!(
        signals.repository,
        Some((
            "github".to_string(),
            "enragedpixel/carry-stacker-reloaded".to_string()
        ))
    );
}

fn forge_repo(forge: &str, path: &str) -> Option<(String, String)> {
    Some((forge.to_string(), path.to_string()))
}

#[test]
fn repository_urls_normalise_to_one_key() {
    for url in [
        "https://github.com/Owner/Repo",
        "https://github.com/Owner/Repo.git",
        "https://www.github.com/owner/repo/",
        "https://raw.githubusercontent.com/Owner/Repo/main/meta.json",
        "https://codeload.github.com/owner/repo/zip/refs/heads/main",
        "https://github.com/owner/repo/archive/refs/heads/main.zip",
        "https://github.com/owner/repo/releases/download/v1/mod.zip",
        "https://api.github.com/repos/owner/repo/releases/latest",
    ] {
        assert_eq!(
            canonical_repository(url),
            forge_repo("github", "owner/repo"),
            "{url}"
        );
    }
    assert_eq!(
        canonical_repository(
            "https://gitlab.com/Steam-Test1/Alternative-Updates/-/raw/main/x.json"
        ),
        forge_repo("gitlab", "steam-test1/alternative-updates")
    );
    // A user's Pages site is owner-scoped, and the first segment is the repository behind it.
    assert_eq!(
        canonical_repository("https://drnewbie.github.io/Mess/Update/Some%20Mod.zip"),
        forge_repo("github", "drnewbie/mess")
    );
    for url in [
        "https://example.com/x.zip",
        "not a url",
        "https://github.com/",
    ] {
        assert_eq!(canonical_repository(url), None, "{url}");
    }
}

#[test]
fn beardlib_main_xml_yields_the_catalog_id_it_declares() {
    let signals = signals_of(
        "main.xml",
        r#"<mod name="Cool Mod" author="Someone" version="2.0">
             <AssetUpdates provider="modworkshop" id="25629"/>
           </mod>"#,
    );
    assert_eq!(signals.declared_name.as_deref(), Some("Cool Mod"));
    assert_eq!(
        signals.embedded_catalog,
        Some(("modworkshop".to_string(), "25629".to_string()))
    );
}

#[test]
fn a_template_placeholder_is_not_a_catalog_id() {
    // Roughly a third of AssetUpdates elements carry one of these.
    for id in ["-1", "0", "YOUR_MOD_ID"] {
        let signals = signals_of(
            "main.xml",
            &format!(r#"<mod name="Template"><AssetUpdates id="{id}"/></mod>"#),
        );
        assert_eq!(signals.embedded_catalog, None, "{id}");
    }
}

#[test]
fn a_directory_without_a_marker_says_nothing() {
    let dir = TempDir::new().unwrap();
    assert_eq!(local_signals(dir.path()), LocalSignals::default());
}

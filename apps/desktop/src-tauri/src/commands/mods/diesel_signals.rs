//! Diesel-family identity signals: what a PAYDAY 2, PAYDAY: The Heist or RAID mod says about
//! itself in its marker file, normalised into the game-neutral LocalSignals the identity model
//! consumes. The rules here look arbitrary because the ecosystem is: mod.txt is hand-written,
//! frequently invalid JSON, and a whole family of mods shares one updater identifier.

use super::identity::LocalSignals;
use std::path::Path;

/// mod.txt is hand-written JSON. Around 7.5% of shipped files are not valid JSON at all
/// (trailing commas are routine, comments and a BOM appear), so a strict parse would throw
/// away identity for one mod in thirteen. Values are scanned out instead, the same approach
/// the existing BeardLib id reader takes.
fn json_string_field(text: &str, key: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let needle = format!("\"{key}\"");
    let mut from = 0;
    while let Some(rel) = text[from..].find(&needle) {
        let at = from + rel;
        from = at + needle.len();
        // Require a boundary before the key so "name" does not match inside "display_name".
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let rest = text[from..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('"') else {
            continue;
        };
        // Take the first unescaped quote, so an escaped quote inside a value cannot end it.
        let mut value = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                // Authors separate contributor credits with a real \n escape, so the common
                // escapes are decoded rather than passed through as their letter.
                '\\' => match chars.next() {
                    Some('n') => value.push('\n'),
                    Some('r') => value.push('\r'),
                    Some('t') => value.push('\t'),
                    Some(escaped) => value.push(escaped),
                    None => break,
                },
                '"' => {
                    let value = value.trim();
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                    break;
                }
                _ => value.push(c),
            }
        }
    }
    None
}

/// Authors credit translators and contributors on continuation lines; only the first line is
/// the author for identity purposes.
fn first_line(value: String) -> String {
    value
        .split(['\n', '\r'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Reduces the many shapes a repository URL arrives in to one forge and one owner/repo pair.
/// Every shape below occurs in the wild: plain repository links, raw file links, generated
/// archive and release asset links, GitHub Pages hosts, .git suffixes, www and mixed case.
pub(crate) fn canonical_repository(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches(['/', ')', ',', '"', '\'']);
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let clean = |segment: &str| {
        segment
            .trim_end_matches(".git")
            .to_ascii_lowercase()
            .to_string()
    };

    // A user's Pages site is one owner-scoped host, and the first path segment is the
    // repository serving it.
    if let Some(owner) = host.strip_suffix(".github.io") {
        let repository = segments.first().map(|s| clean(s))?;
        return Some((
            "github".to_string(),
            format!("{}/{}", clean(owner), repository),
        ));
    }

    let owner_index = match host {
        "github.com"
        | "codeload.github.com"
        | "raw.githubusercontent.com"
        | "objects.githubusercontent.com"
        | "gitlab.com" => 0,
        // https://api.github.com/repos/<owner>/<repo>/...
        "api.github.com" if segments.first() == Some(&"repos") => 1,
        _ => return None,
    };
    let owner = segments.get(owner_index)?;
    let repository = segments.get(owner_index + 1)?;
    if owner.is_empty() || repository.is_empty() {
        return None;
    }
    let forge = if host == "gitlab.com" {
        "gitlab"
    } else {
        "github"
    };
    Some((
        forge.to_string(),
        format!("{}/{}", clean(owner), clean(repository)),
    ))
}

fn host_of(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

/// The per-mod key in a self-hosted updater namespace. BLT's own updates block cannot supply
/// it in every ecosystem: a whole family of mods declares the identifier of the *updater tool*
/// they share, a dozen distinct mods resolving to one identifier, so a download URL that names
/// this mod specifically is the only per-mod key available there.
fn key_from_download_url(url: &str) -> Option<(String, String)> {
    let host = host_of(url)?;
    let path = url.split(['?', '#']).next()?;
    let file = path.rsplit('/').next()?;
    let key = file.strip_suffix(".zip").unwrap_or(file);
    let key = key.trim();
    (!key.is_empty() && key != file.trim_end_matches('/')).then(|| (host, key.to_string()))
}

/// Reads the value of an XML attribute from one element's text.
fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}=", name.to_ascii_lowercase());
    let mut from = 0;
    while let Some(rel) = lower[from..].find(&needle) {
        let at = from + rel;
        let boundary = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
        let eq = at + needle.len();
        from = eq;
        let bytes = tag.as_bytes();
        if !boundary || eq >= bytes.len() || (bytes[eq] != b'"' && bytes[eq] != b'\'') {
            continue;
        }
        let quote = bytes[eq] as char;
        let start = eq + 1;
        if let Some(end) = tag[start..].find(quote) {
            let value = tag[start..start + end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn signals_from_main_xml(text: &str) -> LocalSignals {
    let mut signals = LocalSignals::default();
    if let Some(tag) = text
        .to_ascii_lowercase()
        .find("<mod")
        .and_then(|start| text[start..].find('>').map(|end| &text[start..start + end]))
    {
        signals.declared_name = xml_attr(tag, "name");
        signals.declared_author = xml_attr(tag, "author").map(first_line);
        signals.declared_version = xml_attr(tag, "version");
    }
    // BeardLib's AssetUpdates element names the catalog the mod is published on. The provider
    // defaults to modworkshop when omitted, matching the existing id reader.
    let lower = text.to_ascii_lowercase();
    if let Some(start) = lower.find("<assetupdates") {
        if let Some(end) = text[start..].find('>') {
            let tag = &text[start..start + end];
            let provider = xml_attr(tag, "provider").unwrap_or_else(|| "modworkshop".to_string());
            if let Some(id) = xml_attr(tag, "id") {
                // A template placeholder ("-1", non-numeric text) is not an id. Roughly one
                // AssetUpdates element in three carries one.
                if id.parse::<i64>().is_ok_and(|value| value > 0) {
                    signals.embedded_catalog = Some((provider.to_ascii_lowercase(), id));
                }
            }
        }
    }
    signals
}

fn signals_from_mod_txt(text: &str) -> LocalSignals {
    let mut signals = LocalSignals {
        declared_name: json_string_field(text, "name"),
        declared_author: json_string_field(text, "author").map(first_line),
        declared_version: json_string_field(text, "version"),
        ..LocalSignals::default()
    };

    // Preferred first: a URL that downloads this mod specifically always identifies this mod,
    // whatever the updates block says.
    if let Some((host, key)) = json_string_field(text, "simple_update_url")
        .as_deref()
        .and_then(key_from_download_url)
    {
        signals.updater = Some((host, key));
    }

    let meta = json_string_field(text, "meta");
    let identifier = json_string_field(text, "identifier");
    match (&meta, &identifier) {
        // A hosted updates block. When it points at a forge, the repository is the better
        // signal, since the identifier there is scoped to a document that may serve many mods.
        (Some(meta), Some(identifier)) => {
            if let Some(repository) = canonical_repository(meta) {
                signals.repository = Some(repository);
            } else if signals.updater.is_none() {
                if let Some(host) = host_of(meta) {
                    signals.updater = Some((host, identifier.clone()));
                }
            }
        }
        // An updates entry with an identifier and no host is a paydaymods.com record. The
        // service stopped operating in February 2020; SuperBLT keeps these only so other mods'
        // dependency declarations still resolve. The identifier remains a real name in that
        // namespace, and collides across authors, so it is kept namespaced and never promoted
        // to a live catalog.
        (None, Some(identifier)) => {
            signals.legacy = Some(("paydaymods".to_string(), identifier.clone()));
        }
        _ => {}
    }

    if signals.repository.is_none() {
        // Any other repository URL the mod carries: a contact link, an issues URL, a release
        // asset. Only ever used together with the declared name.
        signals.repository = text
            .split(|c: char| c.is_whitespace() || c == '"')
            .filter(|token| token.starts_with("http://") || token.starts_with("https://"))
            .find_map(canonical_repository);
    }
    signals
}

/// Reads a Diesel-family mod directory and returns what it says about itself. Marker
/// preference matches the scanner's, so identity and hashing always describe the same file.
pub fn local_signals(dir: &Path) -> LocalSignals {
    for marker in ["mod.txt", "main.xml"] {
        let Ok(text) = std::fs::read_to_string(dir.join(marker)) else {
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        return if marker == "main.xml" {
            signals_from_main_xml(text)
        } else {
            signals_from_mod_txt(text)
        };
    }
    LocalSignals::default()
}

#[cfg(test)]
#[path = "diesel_signals_tests.rs"]
mod tests;

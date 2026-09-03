//! The checks a manifest must pass beyond parsing.
//!
//! Serde rejects unknown keys, unknown values and missing required ones. These are the rules
//! it cannot see: agreement between a package and its directory, uniqueness within a list,
//! references between sections, and values that would build a path the scan cannot find.

use crate::{
    Discovery, FileFamily, GamePackage, LoaderBinding, MarkerMode, NewsBinding, SourceBinding,
    StoreBinding, Target, Unit,
};

/// Rejects a manifest that parses but could not work, so a contributor sees the problem at
/// build time rather than as a missing game at runtime. The caller prefixes the message with
/// the manifest path.
pub fn check(id: &str, package: &GamePackage) -> Result<(), String> {
    if package.id != id {
        return Err(format!(
            "declares id '{}', but its directory names it '{id}'",
            package.id
        ));
    }

    if let Some(duplicate) = first_duplicate(package.sources.iter().map(SourceBinding::provider)) {
        return Err(format!("declares two '{duplicate}' sources"));
    }
    for binding in &package.sources {
        // The catalogue publishes this id as a number for the browse API to call.
        let SourceBinding::ModWorkshop { game_id } = binding else {
            continue;
        };
        if game_id.parse::<u64>().is_err() {
            return Err(format!(
                "declares the modworkshop game id '{game_id}', which is not a number"
            ));
        }
    }
    if let Some(duplicate) = first_duplicate(package.news.iter().map(NewsBinding::provider)) {
        return Err(format!("declares two '{duplicate}' news feeds"));
    }
    if let Some(duplicate) =
        first_duplicate(package.install.stores.iter().map(StoreBinding::provider))
    {
        return Err(format!("declares two '{duplicate}' stores"));
    }
    if package.install.stores.is_empty() {
        return Err("lists no store, so the game could never be found".to_string());
    }
    if let Some(duplicate) = first_duplicate(package.loaders.iter().map(LoaderBinding::id)) {
        return Err(format!("declares the '{duplicate}' loader twice"));
    }
    for loader in &package.loaders {
        let LoaderBinding::Ue4ss {
            storefronts,
            proxy_dlls,
            install_into,
            ..
        } = loader
        else {
            continue;
        };
        if storefronts.is_empty() || proxy_dlls.is_empty() || install_into.is_empty() {
            return Err(
                "the ue4ss loader needs at least one storefront, proxy dll and install_into component"
                    .to_string(),
            );
        }
    }

    if package.targets.is_empty() {
        return Err("declares no mod targets, so no mod could be installed".to_string());
    }
    if let Some(duplicate) = first_duplicate(package.targets.iter().map(|t| t.tag.as_str())) {
        return Err(format!("declares two targets tagged '{duplicate}'"));
    }
    let primaries = package.targets.iter().filter(|t| t.primary).count();
    if primaries != 1 {
        return Err(format!(
            "marks {primaries} targets primary; exactly one target must set primary = true"
        ));
    }
    for binding in &package.decoders {
        if !package.targets.iter().any(|t| t.tag == binding.target()) {
            return Err(format!(
                "routes a decoded container to target '{}', which it does not declare",
                binding.target()
            ));
        }
    }
    for target in &package.targets {
        check_target(target).map_err(|problem| format!("target '{}' {problem}", target.tag))?;
    }
    Ok(())
}

fn check_target(target: &Target) -> Result<(), String> {
    if target.path.is_empty() {
        return Err("has an empty path".to_string());
    }
    if target.backup.is_empty() {
        return Err("has an empty backup path".to_string());
    }
    match &target.unit {
        Unit::File {
            family,
            disabled_suffix,
        } => {
            check_family(family)?;
            if disabled_suffix.is_empty() {
                return Err(
                    "has an empty disabled_suffix, so disabling would not rename anything"
                        .to_string(),
                );
            }
        }
        Unit::Directory {
            discovery,
            contains,
            ..
        } => {
            if let Some(family) = contains {
                check_family(family)?;
            }
            check_discovery(discovery)?;
        }
    }
    Ok(())
}

fn check_discovery(discovery: &Discovery) -> Result<(), String> {
    let Discovery::Markers { markers } = discovery else {
        return Ok(());
    };
    if markers.is_empty() {
        return Err(
            "uses the markers policy with no rules; write all_directories if every folder is a mod"
                .to_string(),
        );
    }
    if let Some(duplicate) = first_duplicate(markers.iter().map(|rule| rule.file.as_str())) {
        return Err(format!("lists the marker '{duplicate}' twice"));
    }
    for rule in markers {
        if rule.modes.is_empty() {
            return Err(format!("gives the marker '{}' no modes", rule.file));
        }
        if let Some(duplicate) = first_duplicate(rule.modes.iter().map(mode_name)) {
            return Err(format!(
                "gives the marker '{}' the mode '{duplicate}' twice",
                rule.file
            ));
        }
        if rule.modes.contains(&MarkerMode::Scan) && rule.modes.contains(&MarkerMode::IndexGated) {
            return Err(format!(
                "gives the marker '{}' both scan and index_gated, which contradict: scan accepts the folder outright, index_gated accepts it only on an index match",
                rule.file
            ));
        }
    }
    Ok(())
}

/// Extensions are joined onto a filename stem, so anything that is not a bare extension would
/// build a path the scan cannot find or, worse, one outside the mods directory.
fn check_family(family: &FileFamily) -> Result<(), String> {
    let bare = |value: &str| !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric());
    if !bare(&family.extension) {
        return Err(format!(
            "declares the extension '{}'; write it bare, with no leading dot or path separator",
            family.extension
        ));
    }
    for companion in &family.companions {
        if !bare(companion) {
            return Err(format!(
                "declares the companion extension '{companion}'; write it bare, with no leading dot or path separator"
            ));
        }
        if *companion == family.extension {
            return Err(format!(
                "repeats the primary extension '{companion}' as a companion"
            ));
        }
    }
    if let Some(duplicate) = first_duplicate(family.companions.iter().map(String::as_str)) {
        return Err(format!("lists the companion extension '{duplicate}' twice"));
    }
    Ok(())
}

fn mode_name(mode: &MarkerMode) -> &'static str {
    match mode {
        MarkerMode::Archive => "archive",
        MarkerMode::Scan => "scan",
        MarkerMode::IndexGated => "index_gated",
    }
}

fn first_duplicate<'a>(values: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut seen: Vec<&str> = Vec::new();
    for value in values {
        if seen.contains(&value) {
            return Some(value);
        }
        seen.push(value);
    }
    None
}

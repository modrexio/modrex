use crate::game_package::{GamePackage, Storefront};
use std::fmt::Write as _;

/// Relative to the crate root, which is the directory cargo runs a test binary from.
const CATALOG_PATH: &str = "../../../packages/games/catalog.generated.ts";

fn quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

fn launcher_name(storefront: Storefront) -> &'static str {
    match storefront {
        Storefront::Steam => "Steam",
        Storefront::Epic => "Epic Games",
        Storefront::Xbox => "Xbox App",
    }
}

fn ordered_packages() -> Vec<&'static GamePackage> {
    let mut packages: Vec<&GamePackage> = super::discovered().iter().map(|(_, pkg)| pkg).collect();
    packages.sort_by_key(|pkg| pkg.display_order);
    packages
}

#[cfg(test)]
pub fn quote_for_test(value: &str) -> String {
    quote(value)
}

pub fn catalog_typescript() -> String {
    let mut out = String::from(
        "// Generated from apps/desktop/src-tauri/src/games/<id>/package.rs. Do not edit.\n\n\
         import type { GameSpec } from './types'\n\n\
         export const GAME_SPECS = {\n",
    );

    for pkg in ordered_packages() {
        let workshop_id = pkg
            .sources
            .modworkshop
            .as_ref()
            .map(|binding| {
                binding
                    .game_id
                    .parse::<u64>()
                    .unwrap_or_else(|_| panic!("{}: modworkshop id is not numeric", pkg.id))
            })
            .unwrap_or_else(|| panic!("{}: no modworkshop binding", pkg.id));

        let _ = writeln!(out, "    {}: {{", pkg.id);
        let _ = writeln!(out, "        name: {},", quote(&pkg.display_name));
        let _ = writeln!(out, "        shortName: {},", quote(&pkg.short_name));
        let _ = writeln!(out, "        workshopId: {workshop_id},");
        if let Some(nexus) = pkg.sources.nexus.as_ref() {
            let _ = writeln!(out, "        nexusDomain: {},", quote(&nexus.domain));
        }
        let _ = writeln!(out, "        storageKey: {},", quote(&pkg.id));
        let _ = writeln!(out, "        hasNews: {},", pkg.news.is_some());
        if let Some(flag) = pkg.installation.required_launch_flag.as_ref() {
            let _ = writeln!(out, "        requiredLaunchFlag: {},", quote(flag));
        }

        let launchers: Vec<String> = [
            pkg.installation
                .steam
                .is_some()
                .then_some(Storefront::Steam),
            pkg.installation.epic.is_some().then_some(Storefront::Epic),
            pkg.installation.xbox.is_some().then_some(Storefront::Xbox),
        ]
        .into_iter()
        .flatten()
        .map(|storefront| quote(launcher_name(storefront)))
        .collect();
        let _ = writeln!(out, "        launchers: [{}],", launchers.join(", "));

        let _ = writeln!(out, "        modTargets: [");
        for target in &pkg.targets {
            let _ = writeln!(
                out,
                "            {{ id: {}, path: {} }},",
                quote(&target.tag),
                quote(&target.mods_subpath.join("/"))
            );
        }
        let _ = writeln!(out, "        ],");
        let _ = writeln!(out, "    }},");
    }

    out.push_str("} satisfies Record<string, GameSpec>\n");
    out
}

pub fn export_catalog() {
    std::fs::write(CATALOG_PATH, catalog_typescript())
        .unwrap_or_else(|e| panic!("cannot write {CATALOG_PATH}: {e}"));
}

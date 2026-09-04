use crate::game_package::{GamePackage, SourceBinding, StoreBinding, Storefront};
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
    packages.sort_by(|left, right| left.name.cmp(&right.name));
    packages
}

#[cfg(test)]
pub fn quote_for_test(value: &str) -> String {
    quote(value)
}

pub fn catalog_typescript() -> String {
    let mut out = String::from(
        "// Generated from apps/desktop/src-tauri/src/games/<id>/package.toml. Do not edit.\n\n\
         import type { GameSpec } from './types.js'\n\n\
         export const GAME_SPECS = {\n",
    );

    for pkg in ordered_packages() {
        // A game reaches modworkshop by declaring a binding. Without one the field is absent
        // rather than zero, so the renderer cannot mistake "not listed there" for an id.
        let workshop_id = pkg.sources.iter().find_map(|binding| match binding {
            SourceBinding::ModWorkshop { game_id } => game_id.parse::<u64>().ok(),
            SourceBinding::Nexus { .. } => None,
        });

        let _ = writeln!(out, "    {}: {{", pkg.id);
        let _ = writeln!(out, "        name: {},", quote(&pkg.name));
        let _ = writeln!(out, "        shortName: {},", quote(&pkg.short_name));
        if let Some(id) = workshop_id {
            let _ = writeln!(out, "        workshopId: {id},");
        }
        let nexus_domain = pkg.sources.iter().find_map(|binding| match binding {
            SourceBinding::Nexus { domain, .. } => Some(domain),
            SourceBinding::ModWorkshop { .. } => None,
        });
        if let Some(domain) = nexus_domain {
            let _ = writeln!(out, "        nexusDomain: {},", quote(domain));
        }
        let _ = writeln!(out, "        storageKey: {},", quote(&pkg.id));
        let _ = writeln!(out, "        hasNews: {},", !pkg.news.is_empty());
        // Whether the viewer is offered, never the key it would use. The key stays in
        // the package, which the renderer never reads.
        let _ = writeln!(
            out,
            "        supportsPackageViewer: {},",
            pkg.package_reader.is_some()
        );
        if let Some(flag) = pkg.install.launch_flag.as_ref() {
            let _ = writeln!(out, "        requiredLaunchFlag: {},", quote(flag));
        }

        // Listed in a fixed order so the catalogue does not change when a manifest lists its
        // stores in another order.
        let launchers: Vec<String> = [Storefront::Steam, Storefront::Epic, Storefront::Xbox]
            .into_iter()
            .filter(|wanted| {
                pkg.install.stores.iter().any(|store| {
                    matches!(
                        (store, wanted),
                        (StoreBinding::Steam { .. }, Storefront::Steam)
                            | (StoreBinding::Epic { .. }, Storefront::Epic)
                            | (StoreBinding::Xbox { .. }, Storefront::Xbox)
                    )
                })
            })
            .map(|storefront| quote(launcher_name(storefront)))
            .collect();
        let _ = writeln!(out, "        launchers: [{}],", launchers.join(", "));

        let _ = writeln!(out, "        modTargets: [");
        for target in &pkg.targets {
            let _ = writeln!(
                out,
                "            {{ id: {}, path: {} }},",
                quote(&target.tag),
                quote(&target.path.join("/"))
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

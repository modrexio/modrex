//! Renders a parsed package as the Rust literal that rebuilds it.
//!
//! This lives beside the contract it prints so the two are edited together. Every printer
//! destructures its type without a rest pattern, so a field added above stops this file
//! compiling rather than silently vanishing from the generated data.

use crate::{
    Activation, ConfigLocation, ConfigPresets, DecoderBinding, Discovery, FileFamily, FileNaming,
    GamePackage, GraphicsConfig, Install, LoadOrder, LoaderBinding, MarkerMode, MarkerRule,
    ModMetadata, MovieFormat, MovieReplacement, NamePreset, NewsBinding, PackageReaderBinding,
    SourceBinding, StoreBinding, StoreInstallInto, StorePath, Storefront, Target, TargetLabel,
    Unit,
};

const PATH: &str = "::modrex_game_package";

/// A line break is escaped rather than written through, because rustc normalizes CRLF inside a
/// string literal and would quietly change the value the manifest declared.
fn text(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    format!("\"{escaped}\".to_string()")
}

fn texts(values: &[String]) -> String {
    list(values.iter().map(|value| text(value)).collect())
}

fn list(items: Vec<String>) -> String {
    if items.is_empty() {
        return "Vec::new()".to_string();
    }
    format!("vec![{}]", items.join(", "))
}

fn optional(rendered: Option<String>) -> String {
    match rendered {
        Some(value) => format!("Some({value})"),
        None => "None".to_string(),
    }
}

fn mod_metadata(value: ModMetadata) -> String {
    let variant = match value {
        ModMetadata::Diesel => "Diesel",
        ModMetadata::None => "None",
    };
    format!("{PATH}::ModMetadata::{variant}")
}

fn name_preset(value: NamePreset) -> String {
    let variant = match value {
        NamePreset::DieselInfra => "DieselInfra",
        NamePreset::Ue4ssBundledSubmods => "Ue4ssBundledSubmods",
    };
    format!("{PATH}::NamePreset::{variant}")
}

fn storefront(value: Storefront) -> String {
    let variant = match value {
        Storefront::Steam => "Steam",
        Storefront::Epic => "Epic",
        Storefront::Xbox => "Xbox",
    };
    format!("{PATH}::Storefront::{variant}")
}

fn activation(value: Activation) -> String {
    let variant = match value {
        Activation::Filesystem => "Filesystem",
        Activation::Ue4ssModsTxt => "Ue4ssModsTxt",
    };
    format!("{PATH}::Activation::{variant}")
}

fn load_order(value: LoadOrder) -> String {
    let variant = match value {
        LoadOrder::FilenamePrefix => "FilenamePrefix",
        LoadOrder::None => "None",
    };
    format!("{PATH}::LoadOrder::{variant}")
}

fn target_label(value: TargetLabel) -> String {
    let variant = match value {
        TargetLabel::Mods => "Mods",
        TargetLabel::PakMods => "PakMods",
        TargetLabel::LoaderMods => "LoaderMods",
        TargetLabel::ModkitMods => "ModkitMods",
        TargetLabel::LegacyPaks => "LegacyPaks",
        TargetLabel::Overrides => "Overrides",
    };
    format!("{PATH}::TargetLabel::{variant}")
}

fn marker_mode(value: MarkerMode) -> String {
    let variant = match value {
        MarkerMode::Archive => "Archive",
        MarkerMode::Scan => "Scan",
        MarkerMode::IndexGated => "IndexGated",
    };
    format!("{PATH}::MarkerMode::{variant}")
}

fn marker_rule(value: &MarkerRule) -> String {
    let MarkerRule { file, modes } = value;
    format!(
        "{PATH}::MarkerRule {{ file: {}, modes: {} }}",
        text(file),
        list(modes.iter().copied().map(marker_mode).collect()),
    )
}

fn discovery(value: &Discovery) -> String {
    match value {
        Discovery::AllDirectories => format!("{PATH}::Discovery::AllDirectories"),
        Discovery::Markers { markers } => format!(
            "{PATH}::Discovery::Markers {{ markers: {} }}",
            list(markers.iter().map(marker_rule).collect()),
        ),
        Discovery::UnrealPlugin => format!("{PATH}::Discovery::UnrealPlugin"),
    }
}

fn file_naming(value: FileNaming) -> String {
    let name = match value {
        FileNaming::ModName => "ModName",
        FileNaming::Archive => "Archive",
    };
    format!("{PATH}::FileNaming::{name}")
}

fn file_family(value: &FileFamily) -> String {
    let FileFamily {
        extension,
        companions,
    } = value;
    format!(
        "{PATH}::FileFamily {{ extension: {}, companions: {} }}",
        text(extension),
        texts(companions),
    )
}

fn unit(value: &Unit) -> String {
    match value {
        Unit::File {
            family,
            disabled_suffix,
            filename,
        } => format!(
            "{PATH}::Unit::File {{ family: {}, disabled_suffix: {}, filename: {} }}",
            file_family(family),
            text(disabled_suffix),
            file_naming(*filename),
        ),
        Unit::Directory {
            discovery: policy,
            ignore_preset,
            contains,
        } => format!(
            "{PATH}::Unit::Directory {{ discovery: {}, ignore_preset: {}, contains: {} }}",
            discovery(policy),
            optional(ignore_preset.map(name_preset)),
            optional(contains.as_ref().map(file_family)),
        ),
    }
}

fn target(value: &Target) -> String {
    let Target {
        tag,
        label,
        loader,
        primary,
        scope,
        path,
        disabled,
        backup,
        store_paths,
        activation: how,
        load_order: order,
        unit: shape,
    } = value;
    format!(
        "{PATH}::Target {{ tag: {}, label: {}, loader: {}, primary: {primary}, scope: {PATH}::TargetScope::{scope:?}, path: {}, disabled: {}, backup: {}, store_paths: {}, activation: {}, load_order: {}, unit: {} }}",
        text(tag),
        target_label(*label),
        optional(loader.as_deref().map(text)),
        texts(path),
        optional(disabled.as_deref().map(texts)),
        texts(backup),
        list(store_paths.iter().map(store_path).collect()),
        activation(*how),
        load_order(*order),
        unit(shape),
    )
}

fn store_path(value: &StorePath) -> String {
    let StorePath {
        store,
        path,
        backup,
    } = value;
    format!(
        "{PATH}::StorePath {{ store: {}, path: {}, backup: {} }}",
        storefront(*store),
        texts(path),
        texts(backup),
    )
}

fn store_install_into(value: &StoreInstallInto) -> String {
    let StoreInstallInto {
        store,
        install_into,
    } = value;
    format!(
        "{PATH}::StoreInstallInto {{ store: {}, install_into: {} }}",
        storefront(*store),
        texts(install_into),
    )
}

fn store(value: &StoreBinding) -> String {
    match value {
        StoreBinding::Steam { app_id, folder } => format!(
            "{PATH}::StoreBinding::Steam {{ app_id: {app_id}, folder: {} }}",
            text(folder)
        ),
        StoreBinding::Epic { name } => {
            format!("{PATH}::StoreBinding::Epic {{ name: {} }}", text(name))
        }
        StoreBinding::Xbox {
            product_id,
            executable,
        } => format!(
            "{PATH}::StoreBinding::Xbox {{ product_id: {}, executable: {} }}",
            text(product_id),
            text(executable),
        ),
    }
}

fn install(value: &Install) -> String {
    let Install {
        executables,
        processes,
        launch_flag,
        steam_windows_no_mods_argument,
        stores,
    } = value;
    format!(
        "{PATH}::Install {{ executables: {}, processes: {}, launch_flag: {}, steam_windows_no_mods_argument: {}, stores: {} }}",
        texts(executables),
        texts(processes),
        optional(launch_flag.as_deref().map(text)),
        optional(steam_windows_no_mods_argument.as_deref().map(text)),
        list(stores.iter().map(store).collect()),
    )
}

fn source(value: &SourceBinding) -> String {
    match value {
        SourceBinding::ModWorkshop { game_id } => format!(
            "{PATH}::SourceBinding::ModWorkshop {{ game_id: {} }}",
            text(game_id)
        ),
        SourceBinding::Nexus { domain, numeric_id } => format!(
            "{PATH}::SourceBinding::Nexus {{ domain: {}, numeric_id: {numeric_id} }}",
            text(domain)
        ),
    }
}

fn news(value: &NewsBinding) -> String {
    match value {
        NewsBinding::PaydayTheGame { category } => format!(
            "{PATH}::NewsBinding::PaydayTheGame {{ category: {} }}",
            text(category)
        ),
    }
}

fn loader(value: &LoaderBinding) -> String {
    let ids = |values: &[i64]| list(values.iter().map(|id| format!("{id}i64")).collect());
    let plain = |variant: &str, modworkshop_ids: &[i64]| {
        format!(
            "{PATH}::LoaderBinding::{variant} {{ modworkshop_ids: {} }}",
            ids(modworkshop_ids)
        )
    };
    match value {
        LoaderBinding::Ue4ss {
            modworkshop_ids,
            storefronts,
            proxy_dlls,
            install_into,
            store_install_into: overrides,
        } => format!(
            "{PATH}::LoaderBinding::Ue4ss {{ modworkshop_ids: {}, storefronts: {}, proxy_dlls: {}, install_into: {}, store_install_into: {} }}",
            ids(modworkshop_ids),
            list(storefronts.iter().copied().map(storefront).collect()),
            texts(proxy_dlls),
            texts(install_into),
            list(overrides.iter().map(store_install_into).collect()),
        ),
        LoaderBinding::Superblt { modworkshop_ids } => plain("Superblt", modworkshop_ids),
        LoaderBinding::RaidSuperblt { modworkshop_ids } => plain("RaidSuperblt", modworkshop_ids),
        LoaderBinding::BuiltIn { modworkshop_ids } => plain("BuiltIn", modworkshop_ids),
        LoaderBinding::Dahm { modworkshop_ids } => plain("Dahm", modworkshop_ids),
        LoaderBinding::Pdml { modworkshop_ids } => plain("Pdml", modworkshop_ids),
    }
}

fn decoder(value: &DecoderBinding) -> String {
    match value {
        DecoderBinding::Pdmod { target } => format!(
            "{PATH}::DecoderBinding::Pdmod {{ target: {} }}",
            text(target)
        ),
    }
}

fn package_reader(value: &PackageReaderBinding) -> String {
    match value {
        PackageReaderBinding::Unreal { aes_key } => format!(
            "{PATH}::PackageReaderBinding::Unreal {{ aes_key: {} }}",
            text(aes_key)
        ),
    }
}

impl GamePackage {
    /// The Rust expression that rebuilds this package exactly.
    pub fn rust_literal(&self) -> String {
        let GamePackage {
            id,
            name,
            short_name,
            mod_metadata: metadata,
            sources,
            news: feeds,
            install: installation,
            loaders,
            decoders,
            package_reader: reader,
            movie_replacement: movies,
            config_presets: configs,
            graphics_config: graphics,
            unreal_config,
            targets,
        } = self;
        format!(
            "{PATH}::GamePackage {{ id: {}, name: {}, short_name: {}, mod_metadata: {}, sources: {}, news: {}, install: {}, loaders: {}, decoders: {}, package_reader: {}, movie_replacement: {}, config_presets: {}, graphics_config: {}, unreal_config: {}, targets: {} }}",
            text(id),
            text(name),
            text(short_name),
            mod_metadata(*metadata),
            list(sources.iter().map(source).collect()),
            list(feeds.iter().map(news).collect()),
            install(installation),
            list(loaders.iter().map(loader).collect()),
            list(decoders.iter().map(decoder).collect()),
            optional(reader.as_ref().map(package_reader)),
            optional(movies.as_ref().map(movie_replacement)),
            optional(configs.as_ref().map(config_presets)),
            optional(graphics.as_ref().map(graphics_config)),
            optional(unreal_config.as_ref().map(|value| format!("{PATH}::UnrealConfig {{ roots: {} }}", list(value.roots.iter().map(config_location).collect())))),
            list(targets.iter().map(target).collect()),
        )
    }
}

fn movie_replacement(value: &MovieReplacement) -> String {
    let MovieReplacement {
        formats,
        directory,
        storefronts,
    } = value;
    format!(
        "{PATH}::MovieReplacement {{ formats: {}, directory: {}, storefronts: {} }}",
        list(formats.iter().map(|format| movie_format(*format)).collect()),
        texts(directory),
        list(storefronts.iter().map(|store| storefront(*store)).collect()),
    )
}

fn movie_format(value: MovieFormat) -> String {
    let variant = match value {
        MovieFormat::Bink => "Bink",
        MovieFormat::Mp4 => "Mp4",
    };
    format!("{PATH}::MovieFormat::{variant}")
}

fn config_presets(value: &ConfigPresets) -> String {
    match value {
        ConfigPresets::UnrealEngineIni {} => format!("{PATH}::ConfigPresets::UnrealEngineIni {{}}"),
    }
}

fn graphics_config(value: &GraphicsConfig) -> String {
    let GraphicsConfig {
        filename,
        locations,
    } = value;
    format!(
        "{PATH}::GraphicsConfig {{ filename: {}, locations: {} }}",
        text(filename),
        list(locations.iter().map(config_location).collect()),
    )
}

fn config_location(value: &ConfigLocation) -> String {
    match value {
        ConfigLocation::WindowsUserProfile { store, path } => format!(
            "{PATH}::ConfigLocation::WindowsUserProfile {{ store: {}, path: {} }}",
            storefront(*store),
            texts(path),
        ),
        ConfigLocation::WindowsLocalAppData { store, path } => format!(
            "{PATH}::ConfigLocation::WindowsLocalAppData {{ store: {}, path: {} }}",
            storefront(*store),
            texts(path),
        ),
    }
}

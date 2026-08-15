//! What an installed mod *is*, independent of where it is distributed. Two questions, not one:
//!
//!   project identity   - this folder is the mod "Celer" published under pd2mods.z77.fr
//!   catalog reference  - and it also has a ModWorkshop page we can browse and update from
//!
//! Answering only the second leaves every mod from a self-hosted updater, a GitHub repository
//! or a dead service looking unknown, which is why they are separate. This module owns the
//! first; the second stays in InstalledMod's source/remote_id fields, and the two are written
//! together by InstalledMod::attach_catalog so the identity of a catalog-backed mod always
//! records how that association was established.
//!
//! Nothing here knows what a mod.txt is. Games hand over already-normalised LocalSignals; the
//! ecosystem semantics that produce them live next to the engine that understands them (see
//! diesel_signals.rs for the BLT and BeardLib families).

use serde::{Deserialize, Deserializer, Serialize};

/// How far the evidence goes. Confidence is about the *identity*, never about whether the mod
/// can be updated or browsed: a dead updater namespace still identifies a project exactly as
/// well as a live one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IdentityConfidence {
    Exact,
    Strong,
    /// A plausible guess. Never grants grouping, updates, reinstall or provider association.
    Candidate,
}

/// How a mod's identity was established, recorded by whichever operation established it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IdentityEvidence {
    /// Modrex performed the install and recorded the catalog id at the time.
    InstallProvenance,
    /// The installed bytes matched a catalog file by content hash: SHA256 against the mod
    /// index, MD5 against Nexus's own file-hash index.
    CatalogHash,
    /// A catalog id the mod declares in its own metadata, checked against the index.
    EmbeddedCatalogId,
    /// The provider's own content listing matched this install's published file name and
    /// size, or its content folder segment. Neither a hash nor a title match.
    CatalogContentMatch,
    /// A catalog id taken from the mod's own naming: a single title match in the index, or a
    /// filename that is itself the id. Never confirmed against the installed bytes.
    CatalogName,
    /// A catalog reference an older state file already carried. How it was discovered was not
    /// recorded then and cannot be recovered, so nothing more precise may be claimed for it.
    CatalogReference,
    /// A per-mod key in an updater namespace the mod points at.
    UpdaterNamespace,
    /// A source repository plus the name the mod declares inside it.
    Repository,
    /// An identifier from a distribution service that no longer exists.
    LegacyNamespace,
    /// Declared name and author only.
    NameAuthor,
}

impl IdentityEvidence {
    fn confidence(self) -> IdentityConfidence {
        match self {
            IdentityEvidence::InstallProvenance | IdentityEvidence::CatalogHash => {
                IdentityConfidence::Exact
            }
            IdentityEvidence::EmbeddedCatalogId
            | IdentityEvidence::CatalogContentMatch
            | IdentityEvidence::CatalogName
            | IdentityEvidence::CatalogReference
            | IdentityEvidence::UpdaterNamespace
            | IdentityEvidence::Repository
            | IdentityEvidence::LegacyNamespace => IdentityConfidence::Strong,
            // A copied mod.txt produces this too, so it stays a guess for ever.
            IdentityEvidence::NameAuthor => IdentityConfidence::Candidate,
        }
    }
}

/// One resolved project identity: which project, in which namespace, and on what evidence.
///
/// The namespace is its own field rather than a prefix inside key, so no consumer ever has to
/// split the string to learn what kind of identity it is holding. Namespaces come from
/// different worlds - a catalog ("modworkshop", "nexus"), a self-hosted updater
/// ("pd2mods.z77.fr"), a forge ("github"), a dead service ("paydaymods") - and a namespace
/// implies nothing about what Modrex can do with the mod.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModIdentity {
    pub namespace: String,
    pub key: String,
    pub evidence: IdentityEvidence,
    /// Derived from evidence and never read back from disk, so the two cannot disagree.
    pub confidence: IdentityConfidence,
}

impl ModIdentity {
    pub fn new(
        namespace: impl Into<String>,
        key: impl Into<String>,
        evidence: IdentityEvidence,
    ) -> Self {
        Self {
            namespace: namespace.into(),
            key: key.into(),
            evidence,
            confidence: evidence.confidence(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedIdentity {
    #[serde(default)]
    namespace: Option<String>,
    key: String,
    evidence: IdentityEvidence,
}

impl<'de> Deserialize<'de> for ModIdentity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let persisted = PersistedIdentity::deserialize(deserializer)?;
        let (namespace, key) = match persisted.namespace {
            Some(namespace) => (namespace, persisted.key),
            // A state file can predate the namespace field and carry it as a "namespace:key"
            // prefix instead. This is the only place that shape is ever split apart.
            None => match persisted.key.split_once(':') {
                Some((namespace, key)) => (namespace.to_string(), key.to_string()),
                None => ("local".to_string(), persisted.key),
            },
        };
        Ok(ModIdentity::new(namespace, key, persisted.evidence))
    }
}

/// What a mod claims about itself, already normalised by the game layer. Every identity
/// signal is a (namespace, key) pair so the generic model never parses a game's vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalSignals {
    pub declared_name: Option<String>,
    pub declared_author: Option<String>,
    pub declared_version: Option<String>,
    /// A catalog the mod names itself, e.g. ("modworkshop", "25629").
    pub embedded_catalog: Option<(String, String)>,
    /// A namespace plus a key that identifies this mod within it, e.g.
    /// ("pd2mods.z77.fr", "Celer"). Only set when the game layer could establish that the key
    /// belongs to the mod rather than to the updater tool it uses.
    pub updater: Option<(String, String)>,
    /// Forge and repository, e.g. ("github", "owner/repo"). A repository is not a mod: the
    /// largest hold over a hundred of them, so this only becomes an identity together with a
    /// declared name.
    pub repository: Option<(String, String)>,
    /// An identifier in a distribution namespace that no longer operates.
    pub legacy: Option<(String, String)>,
}

/// Compares two names the way a human would skim them: case, spacing and punctuation vary
/// constantly between a folder, a mod.txt and a catalog title, but a mod claiming an id that
/// belongs to a completely different project shares nothing at all.
pub fn names_are_compatible(left: &str, right: &str) -> bool {
    let normalise = |value: &str| -> String {
        value
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    };
    let (left, right) = (normalise(left), normalise(right));
    if left.is_empty() || right.is_empty() {
        return true;
    }
    left.contains(&right) || right.contains(&left)
}

/// Resolves the identity a mod's own files support, for mods with no catalog association.
/// Pure and offline: no network, no filesystem, so it stays cheap on the get_installed path
/// and cannot become an SSRF surface.
///
/// Order is the strength of the claim: a namespace the mod names itself beats a repository it
/// merely links, and a repository is never an identity without a declared name.
pub fn resolve_identity(signals: &LocalSignals) -> Option<ModIdentity> {
    if let Some((provider, id)) = &signals.embedded_catalog {
        return Some(ModIdentity::new(
            provider,
            id,
            IdentityEvidence::EmbeddedCatalogId,
        ));
    }

    if let Some((namespace, key)) = &signals.updater {
        return Some(ModIdentity::new(
            namespace,
            key,
            IdentityEvidence::UpdaterNamespace,
        ));
    }

    if let (Some((forge, repository)), Some(name)) = (&signals.repository, &signals.declared_name) {
        return Some(ModIdentity::new(
            forge,
            format!("{repository}#{name}"),
            IdentityEvidence::Repository,
        ));
    }

    if let Some((namespace, key)) = &signals.legacy {
        // Exactly as identifying as a live namespace. What a dead service costs is update
        // capability, which identity does not speak to.
        return Some(ModIdentity::new(
            namespace,
            key,
            IdentityEvidence::LegacyNamespace,
        ));
    }

    if let (Some(name), Some(author)) = (&signals.declared_name, &signals.declared_author) {
        return Some(ModIdentity::new(
            "local",
            format!("{}@{}", name.trim(), author.trim()),
            IdentityEvidence::NameAuthor,
        ));
    }

    None
}

// ── wiring into the installed pipeline ────────────────────────────────────────

use super::engine::{ModEngineConfig, SignalSource};
use super::paths::{active_mod_path, disabled_mod_path};
use super::state::get_folder_path;
use super::types::{DeclaredMetadata, InstalledMod, ModFolder};
use crate::commands::mod_index;

/// What the mod says about itself, in whichever vocabulary its game uses.
pub fn local_signals(cfg: &ModEngineConfig, dir: &std::path::Path) -> LocalSignals {
    match cfg.signals {
        SignalSource::Diesel => super::diesel_signals::local_signals(dir),
        SignalSource::None => LocalSignals::default(),
    }
}

/// Where a tracked mod's files sit, or None for kinds whose payload is a single file rather
/// than a directory of metadata.
fn mod_dir(
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    m: &InstalledMod,
) -> Option<std::path::PathBuf> {
    let target = cfg.target_for(m.location.as_deref());
    if !target.is_directory_unit() {
        return None;
    }
    let rel = get_folder_path(folders, m.folder_id.as_deref());
    let active = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
    if active.exists() {
        return Some(active);
    }
    let disabled = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
    disabled.exists().then_some(disabled)
}

/// Drops a self-declared catalog id the catalog itself contradicts. Authors copy each other's
/// metadata, and real mods ship another project's id; when the snapshot can settle
/// it, a contradiction means the id is not this mod's.
fn validate_embedded(
    signals: &mut LocalSignals,
    index: Option<&rusqlite::Connection>,
    game_name: &str,
) {
    let Some((provider, id)) = signals.embedded_catalog.clone() else {
        return;
    };
    if provider != "modworkshop" {
        return;
    }
    let (Some(conn), Ok(numeric)) = (index, id.parse::<i64>()) else {
        return;
    };
    let Some(hit) = mod_index::query_mod_by_id(conn, numeric, game_name) else {
        // Not in the snapshot, so there is nothing to contradict it: link-hosted mods are
        // routinely absent, and dropping the id there would lose a good identity.
        return;
    };
    if let Some(declared) = signals.declared_name.as_deref() {
        if !names_are_compatible(declared, &hit.mod_name) {
            signals.embedded_catalog = None;
        }
    }
}

/// Fills in identity and declared metadata for tracked mods that have neither.
///
/// Identification and installation record their own identity as they establish a catalog
/// association, so what reaches here is the remainder: mods identified only by their own
/// files, and entries from state files written before identity existed.
///
/// Runs once per mod, so a steady-state refresh reads no marker files at all. A recorded
/// identity therefore describes the folder's contents as of the scan that recorded it, the
/// same way name, version and sha256 on the record do; replacing a tracked folder's contents
/// with a different project by hand leaves all of them stale together. Changing the
/// extraction rules in a later release does not re-derive existing identities either: that
/// needs a deliberate one-time clear of locally derived identities, not a rescan here.
pub fn ensure_identities(
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &mut [InstalledMod],
    index: Option<&rusqlite::Connection>,
) -> bool {
    let mut changed = false;
    for m in mods.iter_mut() {
        if m.identity.is_some() {
            continue;
        }
        if let Some(remote_id) = m.remote_id.clone() {
            m.identity = Some(ModIdentity::new(
                m.source.clone(),
                remote_id,
                IdentityEvidence::CatalogReference,
            ));
            changed = true;
            continue;
        }

        let Some(dir) = mod_dir(game_path, cfg, folders, m) else {
            continue;
        };
        let mut signals = local_signals(cfg, &dir);
        validate_embedded(&mut signals, index, cfg.index_game_name);

        let declared = DeclaredMetadata {
            name: signals.declared_name.clone(),
            author: signals.declared_author.clone(),
            version: signals.declared_version.clone(),
        };
        if !declared.is_empty() && m.declared.as_ref() != Some(&declared) {
            m.declared = Some(declared);
            changed = true;
        }
        if let Some(identity) = resolve_identity(&signals) {
            m.identity = Some(identity);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;

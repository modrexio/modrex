/// UE5 IoStore splits a single mod's cooked content across three sibling files sharing one
/// stem: `Foo.pak` (header), `Foo.ucas` (bulk data), `Foo.utoc` (table of contents). Some games
/// (Crime Boss: Rockay City) ship this triplet for essentially every mod; others (PAYDAY 3) ship
/// a bare `.pak` for most mods. Every `ModUnit::File` operation must carry these alongside the
/// `.pak` it already tracks — `InstalledMod` only ever stores the `.pak` filename, so siblings
/// are located via `Path::with_extension` rather than stored explicitly.
pub const PAK_SIDECAR_EXTENSIONS: &[&str] = &["ucas", "utoc"];

/// Replaces the `.{main_ext}` component of `path`'s filename with `.{sidecar_ext}`, preserving
/// anything after it. Plain `Path::with_extension` is unsafe here: a disabled File-unit mod's
/// filename is `Foo.pak.disabled` (`disabled_suffix` appended on top of the real extension), and
/// `with_extension` would replace the trailing `disabled` component instead of `pak`.
pub fn sidecar_path(
    path: &std::path::Path,
    main_ext: &str,
    sidecar_ext: &str,
) -> Option<std::path::PathBuf> {
    let name = path.file_name()?.to_str()?;
    let pat = format!(".{main_ext}");
    let idx = name.rfind(&pat)?;
    let mut new_name = String::with_capacity(name.len() - main_ext.len() + sidecar_ext.len());
    new_name.push_str(&name[..idx]);
    new_name.push('.');
    new_name.push_str(sidecar_ext);
    new_name.push_str(&name[idx + pat.len()..]);
    Some(path.with_file_name(new_name))
}

pub fn strip_priority_prefix(filename: &str) -> &str {
    let bytes = filename.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i < bytes.len() && bytes[i] == b'_' {
        &filename[i + 1..]
    } else {
        filename
    }
}

pub fn apply_priority_prefix(filename: &str, priority: i64) -> String {
    format!("{:03}_{}", priority, strip_priority_prefix(filename))
}

fn sanitize(mod_name: &str) -> String {
    let trimmed = mod_name.trim();
    let mut result = String::new();
    let mut last_sep = false;
    for c in trimmed.chars() {
        if c.is_alphanumeric() || c == '_' || c == '.' || c == '-' {
            result.push(c);
            last_sep = false;
        } else if !last_sep {
            result.push('_');
            last_sep = true;
        }
    }
    result.trim_matches('_').to_string()
}

/// Folder name for a Crime Boss mod installed under `CrimeBoss/Mods/<name>/` — same
/// sanitization as `pak_filename`, minus the `.pak` extension.
pub fn mod_folder_name(mod_name: &str) -> String {
    sanitize(mod_name)
}

pub fn pak_filename(mod_name: &str) -> String {
    let result = sanitize(mod_name);
    format!("{}.pak", result)
}

pub fn hash_filename(filename: &str) -> i64 {
    let mut h: i32 = 0;
    for c in filename.chars() {
        h = 31i32.wrapping_mul(h).wrapping_add(c as u32 as i32);
    }
    if h == 0 {
        -1
    } else {
        -(h.unsigned_abs() as i64)
    }
}

pub fn make_uid(file_id: Option<i64>, filename: &str) -> String {
    match file_id {
        Some(id) => id.to_string(),
        None => strip_priority_prefix(filename).to_string(),
    }
}

/// Recovers a File-unit mod's published filename from its on-disk name, for querying
/// Nexus's content index. Modrex rewrites the name on disk (a numeric priority prefix,
/// and a disabled_suffix appended when the mod is off); querying either as-is returns
/// zero matches because Nexus indexed the archive's original filename.
pub fn recover_published_filename(on_disk_name: &str, disabled_suffix: &str) -> String {
    let without_prefix = strip_priority_prefix(on_disk_name);
    without_prefix
        .strip_suffix(disabled_suffix)
        .unwrap_or(without_prefix)
        .to_string()
}

/// Derives the folder-name segment to query Nexus's content index with, for a
/// Directory-unit mod. Nexus paths appear both as <Name>/main.xml and
/// assets/mod_overrides/<Name>/main.xml, so a leading assets/mod_overrides/ is
/// stripped when present. Returns None when nothing usable remains — an archive that
/// ships a bare root-level marker file has no wrapper folder in Nexus's own index and
/// cannot be matched this way, no matter what folder Modrex synthesized to hold it.
pub fn derive_content_segment(folder_ref: &str) -> Option<&str> {
    const OVERRIDE_PREFIX: &str = "assets/mod_overrides/";
    let stripped = folder_ref
        .strip_prefix(OVERRIDE_PREFIX)
        .unwrap_or(folder_ref);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped)
    }
}

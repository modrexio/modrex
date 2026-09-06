use std::fs;
use std::path::Path;

/// Parses a single mods.txt line, returning the mod name if it is a real entry line (not
/// blank, not a semicolon comment). A leading UTF-8 BOM is ignored, since Rust treats it as
/// an ordinary character rather than stripping it, and the file's first entry would
/// otherwise never match by name. UE4SS's format is ModName : 1 or ModName : 0.
pub(crate) fn entry_name(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches('\u{FEFF}').trim_start();
    if trimmed.is_empty() || trimmed.starts_with(';') {
        return None;
    }
    let colon = line.rfind(':')?;
    let name = line[..colon].trim_start_matches('\u{FEFF}').trim();
    (!name.is_empty()).then_some(name)
}

/// Sets mod_name's : 1 or : 0 value in an existing UE4SS mods.txt, leaving every other line
/// (comments, blanks, ordering, other mods' entries) untouched. Appends a line if the mod
/// has no entry yet, since UE4SS treats a missing entry as enabled and this only runs on an
/// explicit Modrex toggle. No-ops when the file does not exist: UE4SS owns and creates it,
/// and Modrex never synthesizes one from scratch.
pub(crate) fn set_enabled_in_mods_txt(
    path: &Path,
    mod_name: &str,
    enabled: bool,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let value = if enabled { "1" } else { "0" };

    let mut found = false;
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| {
            if !found && entry_name(line) == Some(mod_name) {
                found = true;
                let colon = line
                    .rfind(':')
                    .expect("entry_name confirmed a colon exists");
                return format!("{}: {value}", &line[..colon]);
            }
            line.to_string()
        })
        .collect();
    if !found {
        lines.push(format!("{mod_name} : {value}"));
    }

    let mut out = lines.join(eol);
    out.push_str(eol);
    fs::write(path, out).map_err(|e| e.to_string())
}

/// Reads mod_name's current : 1 or : 0 value out of an existing mods.txt. None covers a
/// missing file, a mod with no entry yet (UE4SS defaults that to enabled, but callers must
/// treat it as unknown rather than assume either value), and a malformed value.
#[allow(dead_code)]
pub(crate) fn read_enabled_from_mods_txt(path: &Path, mod_name: &str) -> Option<bool> {
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        if entry_name(line)? != mod_name {
            return None;
        }
        let colon = line.rfind(':')?;
        match line[colon + 1..].trim() {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        }
    })
}

/// Sets a UE4SS Lua sub-mod's enabled state in mods.txt to match a Modrex enable or disable
/// action. UE4SS reads this file on launch to decide which Mods/ folders load, independent of
/// where the folder physically sits, so this write and not a file move is what takes effect
/// in-game. A failure therefore means the mod did not change state, and the caller has to
/// hear about it rather than record a change the loader will not honour.
pub fn set_enabled(mods_txt_path: &Path, mod_name: &str, enabled: bool) -> Result<(), String> {
    set_enabled_in_mods_txt(mods_txt_path, mod_name, enabled)
}

/// Reads the real enabled value back from mods.txt. The player, or UE4SS's own in-game UI,
/// can toggle a sub-mod by editing this file directly, and Modrex's tracked flag has no way
/// to learn about that on its own.
#[allow(dead_code)]
pub fn read_enabled(mods_txt_path: &Path, mod_name: &str) -> Option<bool> {
    read_enabled_from_mods_txt(mods_txt_path, mod_name)
}

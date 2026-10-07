//! Bink movie replacement for PAYDAY 3 and Crime Boss.
//!
//! A movie slot is a file the game itself plays from its Content/Movies folder, so the only
//! destinations offered are files that folder really holds, plus the slots published intro
//! packs were verified to replace on the one store where that was verified. Archive entry
//! names are source identities and never decide a destination. The user maps each payload.

use super::resource_state::{
    live_content, Content, Deployment, DeploymentBody, Manifest, MovieBaseline, MovieSlot,
    ResourceStore, Step,
};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

// Paths verified by modworkshop.net/mod/47773 and ModWorkshop's game_payday3.py integration.
fn movies_subpath(game_id: &str) -> Option<&'static str> {
    match game_id {
        "pd3" => Some("PAYDAY3/Content/Movies"),
        "cb" => Some("CrimeBoss/Content/Movies"),
        _ => None,
    }
}

/// Slots published packs replace, from the downloaded PAYDAY 3 Skip Startup and Crime Boss
/// Skip Intro archives and the PAYDAY 3 replacement movie's instructions. Offered when absent
/// only on Steam, the one store those instructions were written against.
fn author_verified_slots(game_id: &str) -> &'static [&'static str] {
    match game_id {
        "pd3" => &[
            "StartUp_Unreal.bk2",
            "StartUp_DeepSilver.bk2",
            "StartUp_SBZ.bk2",
            "BG_LoginVideo_01.bk2",
        ],
        "cb" => &[
            "ARC_25FPS.bk2",
            "cs_splash_505_igs_crimeboss.bk2",
            "logo_arc_4k_60fps.bk2",
            "UE4_Logo.bk2",
        ],
        _ => &[],
    }
}

/// Whether resources are routed for this game at all.
pub(crate) fn supports_movies(game_id: &str) -> bool {
    movies_subpath(game_id).is_some()
}

/// The canonical Movies folder of the selected install.
///
/// The install root is canonicalized so a store or prefix symlink above it keeps working,
/// then the Movies folder must canonicalize to somewhere inside that root: a link that points
/// the folder elsewhere would hand Modrex write access outside the game.
pub(crate) fn movies_dir(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
) -> Result<PathBuf, String> {
    let sub = movies_subpath(game_id)
        .ok_or_else(|| format!("movie replacement is not supported for '{game_id}'"))?;
    if launcher == Some("xbox") {
        return Err(
            "movie replacement is not verified for Microsoft Store installs yet".to_string(),
        );
    }
    let root = Path::new(game_path)
        .canonicalize()
        .map_err(|e| format!("the game folder could not be resolved: {e}"))?;
    let dir = root
        .join(sub)
        .canonicalize()
        .map_err(|_| format!("this install has no {sub} folder"))?;
    if !dir.starts_with(&root) {
        return Err(format!(
            "{sub} links outside the game folder; Modrex will not write there"
        ));
    }
    Ok(dir)
}

/// The slots this install offers, sorted.
pub(crate) fn slot_inventory(
    game_id: &str,
    dir: &Path,
    launcher: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut slots = Vec::new();
    for entry in
        std::fs::read_dir(dir).map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        if is_bk2_name(&name) {
            slots.push(name);
        }
    }
    if launcher == Some("steam") {
        for slot in author_verified_slots(game_id) {
            if !slots.iter().any(|s| s.eq_ignore_ascii_case(slot)) {
                slots.push((*slot).to_string());
            }
        }
    }
    let mut unique = HashSet::new();
    for slot in &slots {
        if !unique.insert(slot.to_ascii_lowercase()) {
            return Err("The movie folder contains filenames that differ only in case. Resolve that conflict before replacing movies".into());
        }
    }
    slots.sort();
    Ok(slots)
}

/// .bk2 only. .bak2 and other lookalikes are never treated as movies.
pub(crate) fn is_bk2_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bk2"))
}

/// Resolves a chosen slot, refusing symbolic links and Unix hard-link aliases.
pub(crate) fn slot_destination(
    dir: &Path,
    slot: &str,
    inventory: &[String],
) -> Result<PathBuf, String> {
    if !inventory.iter().any(|s| s == slot) {
        return Err(format!("{slot} is not a movie slot of this install"));
    }
    let dest = dir.join(slot);
    let meta = match std::fs::symlink_metadata(&dest) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(dest),
        Err(e) => return Err(format!("could not inspect {}: {e}", dest.display())),
    };
    if !meta.file_type().is_file() {
        return Err(format!(
            "{slot} is not a regular file; Modrex will not replace it"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(format!(
                "{slot} is hard-linked elsewhere; replacing it would change another copy"
            ));
        }
    }
    Ok(dest)
}

/// Which Bink generation a payload's container declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinkGeneration {
    Bink1,
    Bink2,
}

const BINK_MAX_WIDTH: u32 = 7680;
const BINK_MAX_HEIGHT: u32 = 4800;
const BINK_MAX_AUDIO_TRACKS: u32 = 256;
const BINK_MAX_FRAMES: u32 = 1_000_000;

/// Validates a Bink container, following FFmpeg's libavformat/bink.c probe and read_header.
///
/// Header, little-endian u32 fields: 0 signature (BIK or KB2 plus a revision byte), 4 file
/// size minus 8, 8 frame count, 12 largest frame size, 16 unused, 20 width, 24 height,
/// 28 fps numerator, 32 fps denominator, 36 video flags, 40 audio track count. BIK revision k
/// and KB2 revisions i, j and k carry one more u32. Each audio track then has a u32 max
/// decoded size, a u16 sample rate and u16 flags, and a u32 track id. The frame index follows
/// with one u32 per frame (bit 0 is the keyframe flag). The last frame ends at the file size.
///
/// This proves a structurally complete container, not that the game can play it: a zero-byte
/// or truncated file fails here, a valid 1-frame skip video passes.
pub(crate) fn validate_bink(path: &Path) -> Result<BinkGeneration, String> {
    let mut file = File::open(path).map_err(|e| format!("could not read the movie: {e}"))?;
    let actual_len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut header = [0u8; 44];
    file.read_exact(&mut header)
        .map_err(|_| "the movie is empty or truncated".to_string())?;
    let u32_at = |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let (generation, extra_field) = match (&header[0..3], header[3]) {
        (b"BIK", rev @ (b'b' | b'f' | b'g' | b'h' | b'i' | b'k')) => {
            (BinkGeneration::Bink1, rev == b'k')
        }
        (b"KB2", rev @ (b'a' | b'd' | b'f' | b'g' | b'h' | b'i' | b'j' | b'k')) => {
            (BinkGeneration::Bink2, matches!(rev, b'i' | b'j' | b'k'))
        }
        _ => return Err("the file is not a Bink 1 or Bink 2 movie".to_string()),
    };
    let file_size = u64::from(u32_at(&header, 4)) + 8;
    let frames = u32_at(&header, 8);
    let largest_frame = u64::from(u32_at(&header, 12));
    let (width, height) = (u32_at(&header, 20), u32_at(&header, 24));
    let (fps_num, fps_den) = (u32_at(&header, 28), u32_at(&header, 32));
    let audio_tracks = u32_at(&header, 40);
    if frames == 0 || frames > BINK_MAX_FRAMES {
        return Err("the movie declares an impossible frame count".to_string());
    }
    if width == 0 || width > BINK_MAX_WIDTH || height == 0 || height > BINK_MAX_HEIGHT {
        return Err("the movie declares an impossible frame size".to_string());
    }
    if fps_num == 0 || fps_den == 0 {
        return Err("the movie declares no frame rate".to_string());
    }
    if audio_tracks > BINK_MAX_AUDIO_TRACKS {
        return Err("the movie declares too many audio tracks".to_string());
    }
    if largest_frame > file_size {
        return Err("the movie's largest frame is bigger than the file".to_string());
    }
    if actual_len != file_size {
        return Err("the movie's declared length does not match its bytes".to_string());
    }
    let tail_len =
        u64::from(extra_field) * 4 + u64::from(audio_tracks) * 12 + u64::from(frames) * 4;
    let mut tail = vec![0u8; tail_len as usize];
    file.read_exact(&mut tail)
        .map_err(|_| "the movie is truncated inside its frame index".to_string())?;
    let index = &tail[(tail_len - u64::from(frames) * 4) as usize..];
    let index_end = 44 + tail_len;
    let mut pos = u64::from(u32_at(index, 0) & !1);
    if pos < index_end {
        return Err("the movie's first frame overlaps its header".to_string());
    }
    for i in 0..frames as usize {
        let next = if i + 1 == frames as usize {
            file_size
        } else {
            u64::from(u32_at(index, (i + 1) * 4) & !1)
        };
        if next <= pos || next > file_size {
            return Err("the movie's frame index is invalid".to_string());
        }
        pos = next;
    }
    Ok(generation)
}

/// What a destination should hold right now, from Modrex's own records.
fn expected_live(manifest: &Manifest, destination: &str, skip: &[&str]) -> Option<Content> {
    if let Some((_, slot)) = enabled_owner(manifest, destination, skip) {
        return Some(Content::Present {
            sha256: slot.payload_sha256.clone(),
            size: slot.payload_size,
        });
    }
    manifest
        .movie_baselines
        .iter()
        .find(|b| b.destination == destination)
        .map(|b| b.prior.clone())
}

fn enabled_owner<'a>(
    manifest: &'a Manifest,
    destination: &str,
    skip: &[&str],
) -> Option<(&'a Deployment, &'a MovieSlot)> {
    manifest
        .deployments
        .iter()
        .filter(|d| d.enabled && !skip.contains(&d.id.as_str()))
        .find_map(|d| match &d.body {
            DeploymentBody::Movie { slots } => slots
                .iter()
                .find(|s| s.destination == destination)
                .map(|s| (d, s)),
            DeploymentBody::Ini { .. } => None,
        })
}

fn slots_of(d: &Deployment) -> &[MovieSlot] {
    match &d.body {
        DeploymentBody::Movie { slots } => slots,
        DeploymentBody::Ini { .. } => &[],
    }
}

fn baseline_prior(manifest: &Manifest, destination: &str) -> Option<Content> {
    manifest
        .movie_baselines
        .iter()
        .find(|b| b.destination == destination)
        .map(|b| b.prior.clone())
}

/// A planned movie operation: the file steps plus the manifest edit committing them.
pub(crate) struct MoviePlan {
    pub steps: Vec<Step>,
    pub new_baselines: Vec<MovieBaseline>,
    /// Enabled packs this operation disables because they overlap the one being applied.
    pub switched_off: Vec<String>,
    pub already_current: Vec<String>,
}

/// Plans a pack switch, preserving the first previous setup and refusing external changes.
/// movies_tests.rs enforces that preexisting equal files require neither writes nor baselines.
pub(crate) fn plan_apply(
    store: &ResourceStore,
    manifest: &Manifest,
    pack: &Deployment,
    replacing: Option<&str>,
) -> Result<MoviePlan, String> {
    let new_slots = slots_of(pack);
    let mut switched_off: Vec<String> = Vec::new();
    for slot in new_slots {
        if let Some((owner, _)) = enabled_owner(manifest, &slot.destination, &[pack.id.as_str()]) {
            if Some(owner.id.as_str()) != replacing && !switched_off.contains(&owner.id) {
                switched_off.push(owner.id.clone());
            }
        }
    }
    let mut leaving: Vec<&str> = switched_off.iter().map(String::as_str).collect();
    if let Some(old) = replacing {
        leaving.push(old);
    }

    let mut steps = Vec::new();
    let mut new_baselines = Vec::new();
    let mut already_current = Vec::new();
    let new_dests: HashSet<&str> = new_slots.iter().map(|s| s.destination.as_str()).collect();
    for id in &leaving {
        let Some(old) = manifest
            .deployments
            .iter()
            .find(|d| d.id == *id && d.enabled)
        else {
            continue;
        };
        for slot in slots_of(old) {
            if new_dests.contains(slot.destination.as_str()) {
                continue;
            }
            steps.push(restore_step(manifest, slot)?);
        }
    }
    for slot in new_slots {
        let dest = Path::new(&slot.destination);
        let live = live_content(dest)?;
        let after = Content::Present {
            sha256: slot.payload_sha256.clone(),
            size: slot.payload_size,
        };
        if expected_live(manifest, &slot.destination, &[pack.id.as_str()]).is_none()
            && live == after
        {
            already_current.push(slot.destination.clone());
            continue;
        }
        let before = match expected_live(manifest, &slot.destination, &[pack.id.as_str()]) {
            Some(expected) if expected == live => expected,
            Some(_) => return Err(diverged(&slot.slot)),
            None => {
                let captured = store.capture(dest)?;
                if captured != live {
                    return Err(diverged(&slot.slot));
                }
                new_baselines.push(MovieBaseline {
                    destination: slot.destination.clone(),
                    game_id: pack.game_id.clone(),
                    prior: captured.clone(),
                    captured_at: chrono::Utc::now().to_rfc3339(),
                });
                captured
            }
        };
        steps.push(Step {
            destination: dest.to_path_buf(),
            before,
            after,
        });
    }
    Ok(MoviePlan {
        steps,
        new_baselines,
        switched_off,
        already_current,
    })
}

/// Plans returning an enabled pack's slots to the previous setup.
pub(crate) fn plan_restore(manifest: &Manifest, pack: &Deployment) -> Result<Vec<Step>, String> {
    slots_of(pack)
        .iter()
        .map(|slot| restore_step(manifest, slot))
        .collect()
}

fn restore_step(manifest: &Manifest, slot: &MovieSlot) -> Result<Step, String> {
    let applied = Content::Present {
        sha256: slot.payload_sha256.clone(),
        size: slot.payload_size,
    };
    let dest = Path::new(&slot.destination);
    if live_content(dest)? != applied {
        return Err(diverged(&slot.slot));
    }
    let prior = baseline_prior(manifest, &slot.destination).ok_or_else(|| {
        format!(
            "Modrex has no saved previous setup for {}; nothing was changed",
            slot.slot
        )
    })?;
    Ok(Step {
        destination: dest.to_path_buf(),
        before: applied,
        after: prior,
    })
}

fn diverged(slot: &str) -> String {
    format!(
        "{slot} was changed outside Modrex (a store repair, game update or another tool); its current bytes were kept and nothing was written"
    )
}

/// Drops baselines no deployment references any more. Those destinations are back at
/// their previous setup by the time this runs.
pub(crate) fn prune_baselines(manifest: &mut Manifest) {
    let referenced: HashSet<String> = manifest
        .deployments
        .iter()
        .flat_map(|d| slots_of(d).iter().map(|s| s.destination.clone()))
        .collect();
    manifest
        .movie_baselines
        .retain(|b| referenced.contains(&b.destination));
}

/// Whether an enabled pack's slots still hold its payloads. Compares sizes before hashing so
/// a refresh after a store repair does not hash a whole stock movie.
pub(crate) fn pack_diverged(pack: &Deployment) -> Result<bool, String> {
    for slot in slots_of(pack) {
        let dest = Path::new(&slot.destination);
        match std::fs::metadata(dest) {
            Ok(meta) if meta.len() != slot.payload_size => return Ok(true),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(format!("could not inspect {}: {e}", dest.display())),
        }
        let expected = Content::Present {
            sha256: slot.payload_sha256.clone(),
            size: slot.payload_size,
        };
        if live_content(dest)? != expected {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
#[path = "movies_tests.rs"]
mod tests;

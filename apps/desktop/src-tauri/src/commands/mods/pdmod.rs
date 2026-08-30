// Reference implementation: https://github.com/HW12Dev/PDModExtractor (MIT)
// .pdmod is a password-protected ZIP containing pdmod.json (ItemQueue manifest) plus the
// replacement asset files. BundlePath and BundleExtension in the manifest are Bob Jenkins
// lookup8 hashes, and the hashlist maps them back to game-relative asset paths.

use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use zip::ZipArchive;

/// The extension the format claims. A .pdmod is a ZIP by magic bytes, so nothing else
/// distinguishes one from an ordinary archive.
pub const EXTENSION: &str = "pdmod";

const PDMOD_PASSWORD: &[u8] = b"0$45'5))66S2ixF51a<6}L2UK";

// Bob Jenkins lookup8 hash, direct port of hash.cpp from PDModExtractor.
pub fn hash64(s: &str) -> u64 {
    let k = s.as_bytes();
    let length = k.len() as u64;
    let mut a: u64 = 0;
    let mut b: u64 = 0;
    let mut c: u64 = 0x9e3779b97f4a7c13;

    let mut pos = 0;
    while pos + 24 <= k.len() {
        let word = |off: usize| u64::from_le_bytes(k[pos + off..pos + off + 8].try_into().unwrap());
        a = a.wrapping_add(word(0));
        b = b.wrapping_add(word(8));
        c = c.wrapping_add(word(16));
        mix64(&mut a, &mut b, &mut c);
        pos += 24;
    }

    let tail = &k[pos..];
    c = c.wrapping_add(length);

    let g = |i: usize| tail.get(i).copied().unwrap_or(0) as u64;
    a = a.wrapping_add(
        g(0) | g(1) << 8
            | g(2) << 16
            | g(3) << 24
            | g(4) << 32
            | g(5) << 40
            | g(6) << 48
            | g(7) << 56,
    );
    b = b.wrapping_add(
        g(8) | g(9) << 8
            | g(10) << 16
            | g(11) << 24
            | g(12) << 32
            | g(13) << 40
            | g(14) << 48
            | g(15) << 56,
    );
    c = c.wrapping_add(
        g(16) | g(17) << 8 | g(18) << 16 | g(19) << 24 | g(20) << 32 | g(21) << 40 | g(22) << 56,
    );

    mix64(&mut a, &mut b, &mut c);
    c
}

#[inline]
fn mix64(a: &mut u64, b: &mut u64, c: &mut u64) {
    *a = a.wrapping_sub(*b).wrapping_sub(*c) ^ (*c >> 43);
    *b = b.wrapping_sub(*c).wrapping_sub(*a) ^ (*a << 9);
    *c = c.wrapping_sub(*a).wrapping_sub(*b) ^ (*b >> 8);
    *a = a.wrapping_sub(*b).wrapping_sub(*c) ^ (*c >> 38);
    *b = b.wrapping_sub(*c).wrapping_sub(*a) ^ (*a << 23);
    *c = c.wrapping_sub(*a).wrapping_sub(*b) ^ (*b >> 5);
    *a = a.wrapping_sub(*b).wrapping_sub(*c) ^ (*c >> 35);
    *b = b.wrapping_sub(*c).wrapping_sub(*a) ^ (*a << 49);
    *c = c.wrapping_sub(*a).wrapping_sub(*b) ^ (*b >> 11);
    *a = a.wrapping_sub(*b).wrapping_sub(*c) ^ (*c >> 12);
    *b = b.wrapping_sub(*c).wrapping_sub(*a) ^ (*a << 18);
    *c = c.wrapping_sub(*a).wrapping_sub(*b) ^ (*b >> 22);
}

static HASHLIST: OnceLock<HashMap<u64, &'static str>> = OnceLock::new();

fn hashlist() -> &'static HashMap<u64, &'static str> {
    HASHLIST.get_or_init(|| {
        static DATA: &str = include_str!("pdmod_hashlist.txt");
        DATA.lines()
            .filter(|l| !l.is_empty())
            .map(|l| (hash64(l), l))
            .collect()
    })
}

#[derive(Deserialize)]
struct ItemEntry {
    #[serde(rename = "BundleExtension")]
    bundle_extension: u64,
    #[serde(rename = "BundlePath")]
    bundle_path: u64,
    #[serde(rename = "ReplacementFile")]
    replacement_file: String,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "ItemQueue")]
    item_queue: Vec<ItemEntry>,
}

fn safe_output(base: &Path, name: &str, ext: &str) -> Option<PathBuf> {
    let rel = format!("{name}.{ext}");
    // Normalise separators so Path::components() works correctly on all platforms.
    let rel = rel.replace('\\', "/");
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return None,
        }
    }
    Some(base.join(rel))
}

fn read_entry(archive: &mut ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let mut f = archive
        .by_name_decrypt(name, PDMOD_PASSWORD)
        .map_err(|e| format!("{name}: {e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e: std::io::Error| e.to_string())?;
    Ok(buf)
}

/// Extracts a .pdmod archive into dest_dir, placing each asset at the path derived from
/// resolving its BundlePath and BundleExtension hashes via the embedded hashlist.
/// Entries whose hashes are not in the hashlist are skipped with a log warning.
pub fn extract_pdmod(path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let manifest: Manifest = serde_json::from_slice(&read_entry(&mut archive, "pdmod.json")?)
        .map_err(|e| format!("pdmod.json parse error: {e}"))?;

    let hl = hashlist();
    let mut extracted = 0usize;

    for entry in &manifest.item_queue {
        let Some(type_str) = hl.get(&entry.bundle_extension) else {
            log::warn!(
                "pdmod: unknown BundleExtension hash {} ({})",
                entry.bundle_extension,
                entry.replacement_file
            );
            continue;
        };
        let Some(name_str) = hl.get(&entry.bundle_path) else {
            log::warn!(
                "pdmod: unknown BundlePath hash {} ({})",
                entry.bundle_path,
                entry.replacement_file
            );
            continue;
        };

        let output_path = safe_output(dest_dir, name_str, type_str)
            .ok_or_else(|| format!("pdmod: unsafe output path for {name_str}.{type_str}"))?;

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        fs::write(
            &output_path,
            read_entry(&mut archive, &entry.replacement_file)?,
        )
        .map_err(|e| e.to_string())?;
        extracted += 1;
    }

    if extracted == 0 {
        return Err(
            "pdmod: no entries could be extracted — hashlist may be incomplete for this mod"
                .to_string(),
        );
    }

    log::info!(
        "pdmod: extracted {extracted}/{} entries to {}",
        manifest.item_queue.len(),
        dest_dir.display()
    );
    Ok(())
}

#[cfg(test)]
use std::io::{Cursor, Write};
#[cfg(test)]
use zip::unstable::write::FileOptionsExt;
#[cfg(test)]
use zip::write::{SimpleFileOptions, ZipWriter};

#[cfg(test)]
pub(crate) fn build_pdmod(entries: &[(&str, &str, &[u8])]) -> Vec<u8> {
    // entries: (bundle_path, bundle_ext, file_content)
    let mut item_queue = Vec::new();
    let mut files: Vec<(&str, Vec<u8>)> = Vec::new();
    for (i, (path, ext, content)) in entries.iter().enumerate() {
        let repl = format!("{:04}.repl", i);
        item_queue.push(serde_json::json!({
            "BundlePath": hash64(path),
            "BundleExtension": hash64(ext),
            "ReplacementFile": repl,
        }));
        files.push((Box::leak(repl.into_boxed_str()), content.to_vec()));
    }
    let manifest = serde_json::json!({"ItemQueue": item_queue}).to_string();

    let buf = Vec::new();
    let cursor = Cursor::new(buf);
    let mut zip = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .with_deprecated_encryption(PDMOD_PASSWORD);
    zip.start_file("pdmod.json", opts).unwrap();
    zip.write_all(manifest.as_bytes()).unwrap();
    for (name, content) in &files {
        zip.start_file(name, opts).unwrap();
        zip.write_all(content).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash64_empty() {
        let h1 = hash64("");
        let h2 = hash64("");
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash64_known_type() {
        let h = hash64("texture");
        let hl = hashlist();
        assert_eq!(hl.get(&h), Some(&"texture"));
    }

    #[test]
    fn hash64_different_strings() {
        assert_ne!(hash64("texture"), hash64("movie"));
        assert_ne!(hash64("a"), hash64("b"));
    }

    #[test]
    fn safe_output_rejects_traversal() {
        let base = Path::new("/base");
        assert!(safe_output(base, "../evil", "txt").is_none());
        assert!(safe_output(base, "/absolute", "txt").is_none());
    }

    #[test]
    fn safe_output_accepts_nested() {
        let base = Path::new("/base");
        let result = safe_output(base, "units/weapons/glock", "texture");
        assert!(result.is_some());
        let p = result.unwrap();
        assert!(p.starts_with(base));
        assert!(p.to_string_lossy().ends_with("glock.texture"));
    }

    #[test]
    fn safe_output_normalises_backslash() {
        let base = Path::new("/base");
        let fwd = safe_output(base, "units/weapons/glock", "texture").unwrap();
        let bck = safe_output(base, "units\\weapons\\glock", "texture").unwrap();
        assert_eq!(fwd, bck);
    }

    #[test]
    fn extract_pdmod_roundtrip() {
        // "units/weapons/glock/glock" and "texture" are both in the embedded hashlist.
        let path = "units/weapons/glock/glock";
        let ext = "texture";
        let content = b"FAKE_TEXTURE_DATA";

        let pdmod_bytes = build_pdmod(&[(path, ext, content)]);

        let tmp = std::env::temp_dir().join("modrex_pdmod_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let pdmod_path = tmp.join("test.pdmod");
        let out_dir = tmp.join("out");
        fs::write(&pdmod_path, &pdmod_bytes).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        extract_pdmod(&pdmod_path, &out_dir).expect("extract_pdmod failed");

        let expected = out_dir.join(format!("{path}.{ext}"));
        assert!(
            expected.exists(),
            "output file missing: {}",
            expected.display()
        );
        assert_eq!(fs::read(&expected).unwrap(), content);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_pdmod_skips_unknown_hash() {
        // 0 is an artificial hash that will never appear in the hashlist.
        let manifest =
            r#"{"ItemQueue":[{"BundlePath":0,"BundleExtension":0,"ReplacementFile":"x.repl"}]}"#;

        let buf = Vec::new();
        let cursor = Cursor::new(buf);
        let mut zip = ZipWriter::new(cursor);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .with_deprecated_encryption(PDMOD_PASSWORD);
        zip.start_file("pdmod.json", opts).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("x.repl", opts).unwrap();
        zip.write_all(b"data").unwrap();
        let pdmod_bytes = zip.finish().unwrap().into_inner();

        let tmp = std::env::temp_dir().join("modrex_pdmod_skip_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let pdmod_path = tmp.join("test.pdmod");
        let out_dir = tmp.join("out");
        fs::write(&pdmod_path, &pdmod_bytes).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        let err = extract_pdmod(&pdmod_path, &out_dir).unwrap_err();
        assert!(
            err.contains("no entries could be extracted"),
            "unexpected error: {err}"
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}

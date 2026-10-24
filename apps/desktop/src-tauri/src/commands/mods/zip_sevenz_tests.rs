use super::*;
use sevenz_rust::{SeqReader, SevenZArchiveEntry, SevenZWriter, SourceReader};
use std::io::{Cursor, Seek, SeekFrom, Write};

fn entry(name: &str, directory: bool) -> SevenZArchiveEntry {
    let mut entry = SevenZArchiveEntry::new();
    entry.name = name.into();
    entry.is_directory = directory;
    entry.has_stream = !directory;
    entry
}

fn archive() -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().unwrap();
    let mut writer = SevenZWriter::create(file.path()).unwrap();
    writer
        .push_archive_entry(entry("empty/", true), None::<Cursor<&[u8]>>)
        .unwrap();
    writer
        .push_archive_entry(entry("zero.pak", false), None::<Cursor<&[u8]>>)
        .unwrap();
    writer
        .push_archive_entry(entry("first.pak", false), Some(Cursor::new(b"first")))
        .unwrap();
    writer
        .push_archive_entry(entry("middle/", true), None::<Cursor<&[u8]>>)
        .unwrap();
    writer
        .push_archive_entries(
            vec![
                entry("solid\\same.pak", false),
                entry("solid/same.pak", false),
            ],
            SeqReader::new(vec![
                SourceReader::new(Cursor::new(b"solid first".as_slice())),
                SourceReader::new(Cursor::new(b"solid second".as_slice())),
            ]),
        )
        .unwrap();
    writer
        .push_archive_entry(entry("last.pak", false), Some(Cursor::new(b"last")))
        .unwrap();
    writer.finish().unwrap();
    file
}

fn decoded_entries(path: &Path) -> Vec<(String, bool, Vec<u8>)> {
    let mut entries = Vec::new();
    sevenz_rust::decompress_with_extract_fn(
        File::open(path).unwrap(),
        Path::new("."),
        |entry, reader, _| {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            entries.push((entry.name().replace('\\', "/"), entry.is_directory(), bytes));
            Ok(true)
        },
    )
    .unwrap();
    entries
}

#[test]
fn sevenz_metadata_listing_preserves_decoder_order_and_selected_bytes() {
    let file = archive();
    let expected = decoded_entries(file.path());
    let listed = list_entries_7z(file.path()).unwrap();
    assert_eq!(listed.len(), expected.len());
    assert_eq!(listed[0].name, "first.pak");
    assert_ne!(
        listed[0].name,
        sevenz_rust::Archive::open(file.path()).unwrap().files[0].name()
    );

    let output = tempfile::TempDir::new().unwrap();
    for (index, (listed, (name, directory, bytes))) in listed.iter().zip(&expected).enumerate() {
        assert_eq!((&listed.name, listed.is_dir), (name, *directory));
        if *directory {
            continue;
        }
        let dest = output.path().join(index.to_string());
        extract_entry_at(file.path(), index as u32, &dest).unwrap();
        assert_eq!(std::fs::read(dest).unwrap(), *bytes);
    }
    let duplicate = expected
        .iter()
        .filter(|(name, _, _)| name == "solid/same.pak")
        .map(|(_, _, bytes)| bytes.as_slice())
        .collect::<Vec<_>>();
    assert_eq!(
        duplicate,
        [b"solid first".as_slice(), b"solid second".as_slice()]
    );
}

#[test]
fn sevenz_listing_does_not_decode_corrupt_payloads_but_extraction_rejects_them() {
    let file = archive();
    let metadata = sevenz_rust::Archive::open(file.path()).unwrap();
    let mut bytes = std::fs::OpenOptions::new()
        .write(true)
        .open(file.path())
        .unwrap();
    bytes.seek(SeekFrom::Start(32 + metadata.pack_pos)).unwrap();
    bytes
        .write_all(&vec![0; metadata.pack_sizes.iter().sum::<u64>() as usize])
        .unwrap();
    drop(bytes);

    let listed = list_entries_7z(file.path()).unwrap();
    assert_eq!(listed[0].name, "first.pak");
    let output = tempfile::TempDir::new().unwrap();
    assert!(extract_entry_at(file.path(), 0, &output.path().join("selected.pak")).is_err());
}

#[test]
fn sevenz_selected_solid_entry_keeps_the_extraction_budget() {
    let file = archive();
    let listed = list_entries_7z(file.path()).unwrap();
    let selected = listed
        .iter()
        .position(|e| e.name == "solid/same.pak")
        .unwrap();
    let output = tempfile::TempDir::new().unwrap();
    let mut budget = 3;
    assert!(extract_entry_at_budget(
        file.path(),
        selected as u32,
        &output.path().join("selected.pak"),
        &mut budget,
    )
    .is_err());
}

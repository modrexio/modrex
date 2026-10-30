use super::mp4::{presentation_end, validate_mp4};
use std::fs;

fn atom(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut bytes = ((data.len() + 8) as u32).to_be_bytes().to_vec();
    bytes.extend(kind);
    bytes.extend(data);
    bytes
}

fn joined(kind: &[u8; 4], entries: Vec<Vec<u8>>) -> Vec<u8> {
    atom(kind, &entries.concat())
}

fn table(kind: &[u8; 4], values: &[u32]) -> Vec<u8> {
    let mut data = vec![0; 4];
    for value in values {
        data.extend(value.to_be_bytes());
    }
    atom(kind, &data)
}

fn video_track(offset: u32) -> Vec<u8> {
    let mut header = vec![0; 84];
    header[3] = 3;
    header[12..16].copy_from_slice(&1u32.to_be_bytes());
    header[20..24].copy_from_slice(&1u32.to_be_bytes());
    header[76..80].copy_from_slice(&(64u32 << 16).to_be_bytes());
    header[80..84].copy_from_slice(&(64u32 << 16).to_be_bytes());
    let mut media_header = vec![0; 24];
    media_header[12..16].copy_from_slice(&30u32.to_be_bytes());
    media_header[16..20].copy_from_slice(&1u32.to_be_bytes());
    let mut handler = vec![0; 24];
    handler[8..12].copy_from_slice(b"vide");
    let mut sample_entry = vec![0; 78];
    sample_entry[6..8].copy_from_slice(&1u16.to_be_bytes());
    sample_entry[24..26].copy_from_slice(&64u16.to_be_bytes());
    sample_entry[26..28].copy_from_slice(&64u16.to_be_bytes());
    // Structural parameter sets and one picture NAL exercise the container, not decoding.
    sample_entry.extend(atom(
        b"avcC",
        &[
            1, 77, 0, 31, 0xff, 0xe1, 0, 4, 0x67, 77, 0, 31, 1, 0, 1, 0x68,
        ],
    ));
    let mut description = vec![0, 0, 0, 0, 0, 0, 0, 1];
    description.extend(atom(b"avc1", &sample_entry));
    let sample_table = joined(
        b"stbl",
        vec![
            atom(b"stsd", &description),
            table(b"stts", &[1, 1, 1]),
            table(b"stsc", &[1, 1, 1, 1]),
            table(b"stsz", &[0, 1, 5]),
            table(b"stco", &[1, offset]),
            table(b"stss", &[1, 1]),
        ],
    );
    let mut references = vec![0, 0, 0, 0, 0, 0, 0, 1];
    references.extend(atom(b"url ", &[0, 0, 0, 1]));
    let minf = joined(
        b"minf",
        vec![
            joined(b"dinf", vec![atom(b"dref", &references)]),
            sample_table,
        ],
    );
    joined(
        b"trak",
        vec![
            atom(b"tkhd", &header),
            joined(
                b"mdia",
                vec![atom(b"mdhd", &media_header), atom(b"hdlr", &handler), minf],
            ),
        ],
    )
}

fn movie_with_sample(payload: &[u8]) -> Vec<u8> {
    let ftyp = atom(b"ftyp", b"isom\0\0\0\0isom");
    let mdat = atom(b"mdat", payload);
    let mut movie_header = vec![0; 100];
    movie_header[12..16].copy_from_slice(&30u32.to_be_bytes());
    movie_header[16..20].copy_from_slice(&1u32.to_be_bytes());
    let mut track = video_track(ftyp.len() as u32 + 8);
    replace_u32(&mut track, b"stsz", 16, payload.len() as u32);
    [
        ftyp.clone(),
        mdat,
        joined(b"moov", vec![atom(b"mvhd", &movie_header), track]),
    ]
    .concat()
}

pub(crate) fn sample_mp4() -> Vec<u8> {
    movie_with_sample(&[0, 0, 0, 1, 0x65])
}

fn descriptor(tag: u8, payload: &[u8]) -> Vec<u8> {
    let size = payload.len() as u32;
    let mut bytes = vec![tag];
    for shift in [21, 14, 7] {
        bytes.push(((size >> shift) as u8 & 127) | 128);
    }
    bytes.push(size as u8 & 127);
    bytes.extend(payload);
    bytes
}

fn aac_descriptors() -> Vec<u8> {
    let mut decoder = vec![0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    decoder.extend(descriptor(5, &[0x11, 0x90]));
    let mut stream = vec![0, 1, 0];
    stream.extend(descriptor(4, &decoder));
    stream.extend(descriptor(6, &[2]));
    descriptor(3, &stream)
}

fn movie_with_audio(descriptors: &[u8], wave: bool) -> Vec<u8> {
    let mut bytes = sample_mp4();
    let mut entry = vec![0; 28];
    entry[6..8].copy_from_slice(&1u16.to_be_bytes());
    entry[16..18].copy_from_slice(&2u16.to_be_bytes());
    entry[18..20].copy_from_slice(&16u16.to_be_bytes());
    entry[24..28].copy_from_slice(&(48000u32 << 16).to_be_bytes());
    let esds = atom(b"esds", &[vec![0; 4], descriptors.to_vec()].concat());
    entry.extend(if wave { atom(b"wave", &esds) } else { esds });
    let entry = atom(b"mp4a", &entry);
    let audio_offset = position(&bytes, b"mdat") as u32 + 9;
    let mut track = video_track(audio_offset);
    let old_entry = position(&track, b"avc1") - 4;
    let old_length =
        u32::from_be_bytes(track[old_entry..old_entry + 4].try_into().unwrap()) as usize;
    let delta = entry.len() as i32 - old_length as i32;
    track.splice(old_entry..old_entry + old_length, entry);
    for kind in [b"trak", b"mdia", b"minf", b"stbl", b"stsd"] {
        let offset = position(&track, kind) - 4;
        let length = u32::from_be_bytes(track[offset..offset + 4].try_into().unwrap());
        track[offset..offset + 4]
            .copy_from_slice(&length.checked_add_signed(delta).unwrap().to_be_bytes());
    }
    replace_u32(&mut track, b"tkhd", 16, 2);
    replace_u32(&mut track, b"stsz", 16, 1);
    let handler = position(&track, b"vide");
    track[handler..handler + 4].copy_from_slice(b"soun");

    let mdat = position(&bytes, b"mdat") - 4;
    let media_end = mdat + u32::from_be_bytes(bytes[mdat..mdat + 4].try_into().unwrap()) as usize;
    bytes.insert(media_end, 0x21);
    bytes[mdat..mdat + 4].copy_from_slice(&14u32.to_be_bytes());
    let moov = position(&bytes, b"moov") - 4;
    let length = u32::from_be_bytes(bytes[moov..moov + 4].try_into().unwrap());
    bytes[moov..moov + 4].copy_from_slice(&(length + track.len() as u32).to_be_bytes());
    bytes.extend(track);
    bytes
}

fn check(bytes: &[u8]) -> Result<(), String> {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("movie.mp4");
    fs::write(&path, bytes).unwrap();
    validate_mp4(&path).map(|_| ())
}

fn position(bytes: &[u8], kind: &[u8; 4]) -> usize {
    bytes.windows(4).position(|window| window == kind).unwrap()
}

fn replace_u32(bytes: &mut [u8], kind: &[u8; 4], after_kind: usize, value: u32) {
    let offset = position(bytes, kind) + after_kind;
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

#[test]
fn short_silent_h264_movie_is_structurally_valid() {
    check(&sample_mp4()).unwrap();
    let mut bytes = sample_mp4();
    replace_u32(&mut bytes, b"tkhd", 4, 1);
    check(&bytes).unwrap();
}

#[test]
fn buffered_nal_scanning_skips_bodies_and_checks_following_headers() {
    let mut payload = 9001u32.to_be_bytes().to_vec();
    payload.push(0x65);
    payload.extend(vec![0; 9000]);
    payload.extend([0, 0, 0, 1, 0x06]);
    check(&movie_with_sample(&payload)).unwrap();
    *payload.last_mut().unwrap() = 0x86;
    assert!(check(&movie_with_sample(&payload))
        .unwrap_err()
        .contains("invalid NAL unit"));
}

#[test]
fn media_header_allows_one_clock_tick_of_timing_rounding() {
    let mut bytes = sample_mp4();
    replace_u32(&mut bytes, b"stts", 16, 3000);
    replace_u32(&mut bytes, b"mdhd", 20, 2999);
    check(&bytes).unwrap();
    replace_u32(&mut bytes, b"mdhd", 20, 2998);
    assert!(check(&bytes).unwrap_err().contains("sample timing"));
}

#[test]
fn b_frame_reordering_extends_the_presented_end() {
    // ffmpeg's I, P, B order: decoded at 0, 512, 1024, shown at 1024, 2560, 1536. Its track
    // declares a duration between the 1536 tick decode total and the 3072 tick presented end.
    assert_eq!(
        presentation_end(
            [(3, 512)].into_iter(),
            [(1, 1024), (1, 2048), (1, 512)].into_iter()
        ),
        3072
    );
    assert_eq!(
        presentation_end([(2, 3)].into_iter(), [(2, 0)].into_iter()),
        6
    );
}

/// Inserts a one-sample composition offset table after the sample timing table.
fn with_composition(mut movie: Vec<u8>, version: u8, offset: u32) -> Vec<u8> {
    let mut data = vec![version, 0, 0, 0];
    data.extend(1u32.to_be_bytes());
    data.extend(1u32.to_be_bytes());
    data.extend(offset.to_be_bytes());
    let ctts = atom(b"ctts", &data);
    for kind in [b"moov", b"trak", b"mdia", b"minf", b"stbl"] {
        let at = position(&movie, kind) - 4;
        let size = u32::from_be_bytes(movie[at..at + 4].try_into().unwrap()) + ctts.len() as u32;
        movie[at..at + 4].copy_from_slice(&size.to_be_bytes());
    }
    let stts = position(&movie, b"stts") - 4;
    let end = stts + u32::from_be_bytes(movie[stts..stts + 4].try_into().unwrap()) as usize;
    movie.splice(end..end, ctts);
    movie
}

#[test]
fn declared_duration_may_reach_the_latest_composition_end() {
    let mut decoded = sample_mp4();
    replace_u32(&mut decoded, b"stts", 16, 3000);
    for (version, offset, latest) in [(0, 1000, 4000), (1, (-500i32) as u32, 3000)] {
        let movie = with_composition(decoded.clone(), version, offset);
        let declared = |duration: u32| {
            let mut bytes = movie.clone();
            replace_u32(&mut bytes, b"mdhd", 20, duration);
            check(&bytes)
        };
        for accepted in [2999, 3000, latest, latest + 1] {
            declared(accepted).unwrap();
        }
        for refused in [2998, latest + 2] {
            assert!(declared(refused).unwrap_err().contains("sample timing"));
        }
    }
    // The parser reads every offset as signed, so the largest one only widens the accepted
    // range and never overflows.
    let extreme = with_composition(decoded, 0, i32::MAX as u32);
    for duration in [3000, 2_000_000_000] {
        let mut bytes = extreme.clone();
        replace_u32(&mut bytes, b"mdhd", 20, duration);
        check(&bytes).unwrap();
    }
}

#[test]
fn every_truncated_prefix_is_refused() {
    let bytes = sample_mp4();
    for length in 0..bytes.len() {
        assert!(check(&bytes[..length]).is_err(), "accepted prefix {length}");
    }
}

#[test]
fn invalid_box_lengths_and_excessive_metadata_are_refused() {
    for length in [0, 1, 7, u32::MAX] {
        let mut bytes = sample_mp4();
        bytes[..4].copy_from_slice(&length.to_be_bytes());
        assert!(check(&bytes).is_err());
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("oversized.mp4");
    let file = fs::File::create(&path).unwrap();
    file.set_len(512 * 1024 * 1024 + 1).unwrap();
    assert!(validate_mp4(&path).unwrap_err().contains("512 MiB"));

    let mut bytes = sample_mp4();
    let offset = position(&bytes, b"moov") - 4;
    bytes.resize(offset + 16 * 1024 * 1024 + 1, 0);
    bytes[offset..offset + 4].copy_from_slice(&(16 * 1024 * 1024 + 1u32).to_be_bytes());
    assert!(check(&bytes).unwrap_err().contains("metadata exceeds"));
}

#[test]
fn sample_table_counts_are_bounded_before_parser_allocation() {
    for (kind, field) in [
        (*b"stsd", 8),
        (*b"stts", 8),
        (*b"stsc", 8),
        (*b"stco", 8),
        (*b"stss", 8),
        (*b"stsz", 12),
    ] {
        let mut bytes = sample_mp4();
        replace_u32(&mut bytes, &kind, field, u32::MAX);
        assert!(
            check(&bytes).is_err(),
            "accepted excessive {:?} count",
            kind
        );
    }
}

#[test]
fn box_work_is_bounded_across_parent_containers() {
    let mut bytes = sample_mp4();
    let padding = atom(b"free", &[]).repeat(2048);
    let movie = position(&bytes, b"moov") - 4;
    let movie_length = u32::from_be_bytes(bytes[movie..movie + 4].try_into().unwrap());
    bytes.extend(&padding);
    bytes[movie..movie + 4].copy_from_slice(&(movie_length + padding.len() as u32).to_be_bytes());
    bytes.extend(&padding);
    assert!(check(&bytes).unwrap_err().contains("too many boxes"));
}

#[test]
fn offsets_sizes_chunk_mapping_and_timing_must_agree() {
    for (kind, field, value) in [
        (*b"stco", 12, 0),
        (*b"stco", 12, u32::MAX),
        (*b"stsz", 16, 0),
        (*b"stsz", 16, 100),
        (*b"stsc", 12, 0),
        (*b"stsc", 16, 0),
        (*b"stsc", 20, 2),
        (*b"stts", 12, 2),
        (*b"stts", 16, 0),
        (*b"stts", 16, 3),
        (*b"mdhd", 16, 0),
        (*b"mdhd", 20, 0),
        (*b"stss", 12, 2),
    ] {
        let mut bytes = sample_mp4();
        replace_u32(&mut bytes, &kind, field, value);
        assert!(
            check(&bytes).is_err(),
            "accepted {:?} field {field} value {value}",
            kind
        );
    }
}

#[test]
fn samples_can_advance_across_media_boxes_but_cannot_enter_gaps() {
    let ftyp = atom(b"ftyp", b"isom\0\0\0\0isom");
    let empty = atom(b"mdat", &[]);
    let media = atom(b"mdat", &[0, 0, 0, 1, 0x65]);
    let gap = atom(b"free", &[0; 16]);
    let first_offset = (ftyp.len() + empty.len() + 8) as u32;
    let second_offset = first_offset + media.len() as u32 + gap.len() as u32;
    let mut track = video_track(first_offset);
    let sizes = position(&track, b"stsz") - 4;
    track.splice(sizes..sizes + 24, table(b"stsz", &[5, 2]));
    let offsets = position(&track, b"stco") - 4;
    track.splice(
        offsets..offsets + 20,
        table(b"stco", &[2, first_offset, second_offset]),
    );
    replace_u32(&mut track, b"stts", 12, 2);
    replace_u32(&mut track, b"mdhd", 20, 2);
    replace_u32(&mut track, b"tkhd", 24, 2);
    let mut header = vec![0; 100];
    header[12..16].copy_from_slice(&30u32.to_be_bytes());
    header[16..20].copy_from_slice(&2u32.to_be_bytes());
    let bytes = [
        ftyp,
        empty,
        media.clone(),
        gap,
        media,
        joined(b"moov", vec![atom(b"mvhd", &header), track]),
    ]
    .concat();
    check(&bytes).unwrap();
    for offset in [first_offset + 5, second_offset - 1, second_offset + 1] {
        let mut invalid = bytes.clone();
        replace_u32(&mut invalid, b"stco", 16, offset);
        assert!(check(&invalid)
            .unwrap_err()
            .contains("outside its media data"));
    }
    let mut crossing = bytes;
    replace_u32(&mut crossing, b"stsz", 8, 6);
    assert!(check(&crossing)
        .unwrap_err()
        .contains("outside its media data"));
}

#[test]
fn unsupported_codec_profile_audio_only_and_fragmented_movies_are_refused() {
    let mut codec = sample_mp4();
    let offset = position(&codec, b"avc1");
    codec[offset..offset + 4].copy_from_slice(b"hvc1");
    assert!(check(&codec).is_err());
    let mut missing_configuration = sample_mp4();
    let offset = position(&missing_configuration, b"avcC");
    missing_configuration[offset..offset + 4].copy_from_slice(b"junk");
    assert!(check(&missing_configuration).is_err());
    let mut oversized_configuration = sample_mp4();
    let offset = position(&oversized_configuration, b"avcC") - 4;
    oversized_configuration[offset..offset + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(check(&oversized_configuration)
        .unwrap_err()
        .contains("outside its parent"));
    let mut profile = sample_mp4();
    let offset = position(&profile, b"avcC") + 5;
    profile[offset] = 110;
    assert!(check(&profile).is_err());
    let mut mismatched_handler = sample_mp4();
    let offset = position(&mismatched_handler, b"vide");
    mismatched_handler[offset..offset + 4].copy_from_slice(b"soun");
    assert!(check(&mismatched_handler)
        .unwrap_err()
        .contains("handler disagrees"));
    let mut audio_only = movie_with_audio(&aac_descriptors(), false);
    let video = position(&audio_only, b"trak") - 4;
    let video_length =
        u32::from_be_bytes(audio_only[video..video + 4].try_into().unwrap()) as usize;
    audio_only.drain(video..video + video_length);
    let movie = position(&audio_only, b"moov") - 4;
    let movie_length = u32::from_be_bytes(audio_only[movie..movie + 4].try_into().unwrap());
    audio_only[movie..movie + 4]
        .copy_from_slice(&(movie_length - video_length as u32).to_be_bytes());
    assert!(check(&audio_only)
        .unwrap_err()
        .contains("requires one H.264 video"));
    let mut repeated_video = sample_mp4();
    let mut extra_track = video_track(position(&repeated_video, b"mdat") as u32 + 4);
    replace_u32(&mut extra_track, b"tkhd", 16, 2);
    let movie = position(&repeated_video, b"moov") - 4;
    let movie_length = u32::from_be_bytes(repeated_video[movie..movie + 4].try_into().unwrap());
    repeated_video[movie..movie + 4]
        .copy_from_slice(&(movie_length + extra_track.len() as u32).to_be_bytes());
    repeated_video.extend(extra_track);
    assert!(check(&repeated_video)
        .unwrap_err()
        .contains("repeats its video"));
    let mut fragmented = sample_mp4();
    fragmented.extend(atom(b"moof", &[]));
    assert!(check(&fragmented).unwrap_err().contains("fragmented"));
}

#[test]
fn external_data_references_and_invalid_picture_nals_are_refused() {
    let mut external = sample_mp4();
    replace_u32(&mut external, b"url ", 4, 0);
    assert!(check(&external).is_err());
    for nal in [0, 0x67, 0x85, 31] {
        let mut bytes = sample_mp4();
        let offset = position(&bytes, b"mdat") + 8;
        bytes[offset] = nal;
        assert!(check(&bytes).is_err());
    }
    let mut bytes = sample_mp4();
    replace_u32(&mut bytes, b"mdat", 4, 20);
    assert!(check(&bytes).is_err());
}

#[test]
fn video_sample_work_is_bounded_independently_of_metadata_counts() {
    let payload = [0, 0, 0, 1, 0x65].repeat(4097);
    assert!(check(&movie_with_sample(&payload))
        .unwrap_err()
        .contains("too many video NAL"));
}

#[test]
fn aac_lc_audio_descriptors_and_wave_layout_are_bounded_before_parsing() {
    for wave in [false, true] {
        check(&movie_with_audio(&aac_descriptors(), wave)).unwrap();
        let mut nested = aac_descriptors();
        for _ in 0..100 {
            nested = descriptor(3, &[vec![0, 1, 0], nested].concat());
        }
        assert!(check(&movie_with_audio(&nested, wave))
            .unwrap_err()
            .contains("nested too deeply"));
        assert!(check(&movie_with_audio(&[3, 0x80, 0x80, 0x80, 0x80], wave)).is_err());
    }
    let mut unsupported = aac_descriptors();
    let asc = unsupported
        .windows(2)
        .position(|pair| pair == [0x11, 0x90])
        .unwrap();
    unsupported[asc] = 0x09;
    assert!(check(&movie_with_audio(&unsupported, false))
        .unwrap_err()
        .contains("AAC LC"));
    let mut unsupported_rate = aac_descriptors();
    let asc = unsupported_rate
        .windows(2)
        .position(|pair| pair == [0x11, 0x90])
        .unwrap();
    unsupported_rate[asc] = 0x16;
    unsupported_rate[asc + 1] = 0x10;
    assert!(check(&movie_with_audio(&unsupported_rate, false))
        .unwrap_err()
        .contains("AAC LC"));
}

#[test]
#[ignore = "reads the locally installed Ready or Not movies without modifying them"]
fn installed_ready_or_not_movies_validate_without_writes() {
    let directory = std::env::var_os("MODREX_RON_MOVIES")
        .expect("set MODREX_RON_MOVIES to the installed Content/Movies folder");
    let mut count = 0;
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
        {
            validate_mp4(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            count += 1;
        }
    }
    assert!(count > 0);
}

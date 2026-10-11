//! Checks complete, nonfragmented H.264 MP4 movies with optional AAC LC audio.
//!
//! The metadata parser does not validate sample offsets against media boxes. Its table
//! allocations also precede EOF checks, so box ranges and counts must be bounded first.
//! Container validation does not decode frames or guarantee playback in the game.

use mp4parse::{AudioCodecSpecific, CodecType, SampleEntry, Track, TrackType, VideoCodecSpecific};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::Path;

const MAX_MOVIE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SAMPLES: u32 = 1_000_000;
const MAX_BOXES: usize = 4096;
const MAX_NALS_PER_SAMPLE: usize = 4096;
const MAX_VIDEO_NALS: usize = 2_000_000;

#[derive(Clone, Copy)]
struct Mp4Box {
    kind: [u8; 4],
    start: u64,
    content: u64,
    end: u64,
}

fn read_at<const N: usize>(file: &mut File, offset: u64) -> Result<[u8; N], String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("could not seek inside the MP4: {e}"))?;
    let mut bytes = [0; N];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("the MP4 is truncated or unreadable: {e}"))?;
    Ok(bytes)
}

fn boxes(file: &mut File, start: u64, end: u64, count: &mut usize) -> Result<Vec<Mp4Box>, String> {
    let mut offset = start;
    let mut result = Vec::new();
    while offset < end {
        if end - offset < 8 || *count == MAX_BOXES {
            return Err("the MP4 has an incomplete box header or too many boxes".into());
        }
        *count += 1;
        let header = read_at::<8>(file, offset)?;
        let size = u32::from_be_bytes(header[..4].try_into().expect("four size bytes"));
        let kind = header[4..].try_into().expect("four box type bytes");
        let (length, header_length) = match size {
            0 if kind == *b"mdat" => (end - offset, 8),
            0 => return Err("only the final MP4 media box may extend to EOF".into()),
            1 if end - offset >= 16 => (u64::from_be_bytes(read_at(file, offset + 8)?), 16),
            1 => return Err("the MP4 has an incomplete extended box header".into()),
            _ => (u64::from(size), 8),
        };
        if length < header_length || length > end - offset {
            return Err("an MP4 box extends outside its parent or the file".into());
        }
        result.push(Mp4Box {
            kind,
            start: offset,
            content: offset + header_length,
            end: offset + length,
        });
        offset += length;
    }
    Ok(result)
}

fn required<'a>(entries: &'a [Mp4Box], kind: &[u8; 4]) -> Result<&'a Mp4Box, String> {
    let mut matches = entries.iter().filter(|entry| entry.kind == *kind);
    let entry = matches.next().ok_or_else(|| {
        format!(
            "the MP4 is missing its {} box",
            String::from_utf8_lossy(kind)
        )
    })?;
    if matches.next().is_some() {
        return Err(format!(
            "the MP4 repeats its {} box",
            String::from_utf8_lossy(kind)
        ));
    }
    Ok(entry)
}

fn table_count(
    file: &mut File,
    entry: &Mp4Box,
    prefix: u64,
    stride: u64,
    limit: u32,
) -> Result<u32, String> {
    if entry.end - entry.content < prefix {
        return Err("an MP4 sample table is truncated".into());
    }
    let version_flags = read_at::<4>(file, entry.content)?;
    let valid_version =
        version_flags[0] == 0 || version_flags[0] == 1 && matches!(&entry.kind, b"ctts" | b"elst");
    if !valid_version || version_flags[1..] != [0, 0, 0] {
        return Err("an MP4 table has an unsupported version or flags".into());
    }
    let count = u32::from_be_bytes(read_at(file, entry.content + prefix - 4)?);
    if count > limit || u64::from(count) * stride != entry.end - entry.content - prefix {
        return Err("an MP4 sample table has an invalid length or excessive count".into());
    }
    Ok(count)
}

fn esds_descriptors(data: &[u8], depth: usize, count: &mut usize) -> Result<(), String> {
    if depth > 4 {
        return Err("the MP4 audio descriptors are nested too deeply".into());
    }
    let mut offset = 0;
    while offset < data.len() {
        if *count == 64 {
            return Err("the MP4 contains too many audio descriptors".into());
        }
        *count += 1;
        let tag = data[offset];
        offset += 1;
        let mut size = 0usize;
        let mut terminated = false;
        for _ in 0..4 {
            let byte = *data
                .get(offset)
                .ok_or("an MP4 audio descriptor length is truncated")?;
            offset += 1;
            size = (size << 7) | usize::from(byte & 127);
            if byte & 128 == 0 {
                terminated = true;
                break;
            }
        }
        if !terminated {
            return Err("an MP4 audio descriptor length is invalid".into());
        }
        let body = data
            .get(offset..offset + size)
            .ok_or("an MP4 audio descriptor is truncated")?;
        match tag {
            3 => {
                if body.len() < 3 || body[2] & 0xe0 != 0 {
                    return Err("external or dependent MP4 audio streams are not supported".into());
                }
                esds_descriptors(&body[3..], depth + 1, count)?;
            }
            4 => {
                let children = body
                    .get(13..)
                    .ok_or("the MP4 audio decoder descriptor is truncated")?;
                esds_descriptors(children, depth + 1, count)?;
            }
            _ => {}
        }
        offset += size;
    }
    Ok(())
}

fn audio_descriptors(file: &mut File, codec: &Mp4Box, box_count: &mut usize) -> Result<(), String> {
    if codec.end - codec.content < 28 {
        return Err("the MP4 audio sample entry is truncated".into());
    }
    let version = u16::from_be_bytes(read_at(file, codec.content + 8)?);
    let prefix = match version {
        0 => 28,
        1 => 44,
        2 => 64,
        _ => return Err("the MP4 audio sample-entry version is unsupported".into()),
    };
    if codec.end - codec.content < prefix {
        return Err("the MP4 audio sample entry is truncated".into());
    }
    let children = boxes(file, codec.content + prefix, codec.end, box_count)?;
    let mut descriptors: Vec<_> = children
        .iter()
        .filter(|entry| entry.kind == *b"esds")
        .copied()
        .collect();
    for wave in children.iter().filter(|entry| entry.kind == *b"wave") {
        descriptors.extend(
            boxes(file, wave.content, wave.end, box_count)?
                .into_iter()
                .filter(|entry| entry.kind == *b"esds"),
        );
    }
    if descriptors.len() != 1 {
        return Err("the MP4 requires one AAC decoder description".into());
    }
    let descriptor = &descriptors[0];
    let length = descriptor.end - descriptor.content;
    if !(4..=65536).contains(&length) {
        return Err("the MP4 audio description is incomplete or exceeds 64 KiB".into());
    }
    let mut bytes = vec![0; length as usize];
    file.seek(SeekFrom::Start(descriptor.content))
        .map_err(|e| format!("could not seek to the MP4 audio description: {e}"))?;
    file.read_exact(&mut bytes)
        .map_err(|e| format!("could not read the MP4 audio description: {e}"))?;
    if bytes[..4] != [0, 0, 0, 0] {
        return Err("the MP4 audio description has an unsupported version or flags".into());
    }
    esds_descriptors(&bytes[4..], 0, &mut 0)
}

fn track_sample_count(
    file: &mut File,
    track: &Mp4Box,
    box_count: &mut usize,
) -> Result<u32, String> {
    let children = boxes(file, track.content, track.end, box_count)?;
    required(&children, b"tkhd")?;
    if children.iter().any(|entry| entry.kind == *b"tref") {
        return Err("MP4 track references are not supported".into());
    }
    for edit in children.iter().filter(|entry| entry.kind == *b"edts") {
        let entries = boxes(file, edit.content, edit.end, box_count)?;
        let list = required(&entries, b"elst")?;
        let version = read_at::<1>(file, list.content)?[0];
        let stride = match version {
            0 => 12,
            1 => 20,
            _ => return Err("the MP4 has an unsupported edit-list version".into()),
        };
        table_count(file, list, 8, stride, 2)?;
    }
    let media = required(&children, b"mdia")?;
    let media_children = boxes(file, media.content, media.end, box_count)?;
    required(&media_children, b"mdhd")?;
    let handler = required(&media_children, b"hdlr")?;
    if handler.end - handler.content < 12 {
        return Err("the MP4 media handler is truncated".into());
    }
    let handler_type = read_at::<4>(file, handler.content + 8)?;
    let minf = required(&media_children, b"minf")?;
    let minf_children = boxes(file, minf.content, minf.end, box_count)?;
    let dinf = required(&minf_children, b"dinf")?;
    let references = boxes(file, dinf.content, dinf.end, box_count)?;
    let dref = required(&references, b"dref")?;
    if dref.end - dref.content < 8 || u32::from_be_bytes(read_at(file, dref.content + 4)?) != 1 {
        return Err("the MP4 must use one internal data reference".into());
    }
    let urls = boxes(file, dref.content + 8, dref.end, box_count)?;
    let url = required(&urls, b"url ")?;
    if urls.len() != 1
        || url.end - url.content != 4
        || read_at::<4>(file, url.content)? != [0, 0, 0, 1]
    {
        return Err("external MP4 data references are not supported".into());
    }
    let stbl = required(&minf_children, b"stbl")?;
    let tables = boxes(file, stbl.content, stbl.end, box_count)?;
    let mut seen = HashSet::new();
    for table in &tables {
        if !seen.insert(table.kind) {
            return Err("the MP4 repeats a sample table".into());
        }
        match &table.kind {
            b"stts" | b"ctts" => {
                table_count(file, table, 8, 8, MAX_SAMPLES)?;
            }
            b"stsc" => {
                table_count(file, table, 8, 12, MAX_SAMPLES)?;
            }
            b"stco" | b"stss" => {
                table_count(file, table, 8, 4, MAX_SAMPLES)?;
            }
            b"co64" => {
                table_count(file, table, 8, 8, MAX_SAMPLES)?;
            }
            b"stz2" => return Err("compact MP4 sample sizes are not supported".into()),
            _ => {}
        }
    }
    required(&tables, b"stts")?;
    required(&tables, b"stsc")?;
    if tables
        .iter()
        .filter(|entry| matches!(&entry.kind, b"stco" | b"co64"))
        .count()
        != 1
    {
        return Err("the MP4 must have one chunk-offset table per track".into());
    }
    let descriptions = required(&tables, b"stsd")?;
    if descriptions.end - descriptions.content < 8
        || read_at::<4>(file, descriptions.content)? != [0, 0, 0, 0]
        || u32::from_be_bytes(read_at(file, descriptions.content + 4)?) != 1
    {
        return Err("the MP4 must have one codec description per track".into());
    }
    let codecs = boxes(file, descriptions.content + 8, descriptions.end, box_count)?;
    if codecs.len() != 1 || !matches!(&codecs[0].kind, b"avc1" | b"mp4a") {
        return Err("the MP4 must contain H.264 video and optional AAC LC audio".into());
    }
    let codec = &codecs[0];
    let (expected_handler, prefix) = if codec.kind == *b"avc1" {
        (*b"vide", 78)
    } else {
        (*b"soun", 28)
    };
    if handler_type != expected_handler || codec.end - codec.content < prefix {
        return Err(
            "the MP4 media handler disagrees with its codec or the codec is truncated".into(),
        );
    }
    if u16::from_be_bytes(read_at(file, codec.content + 6)?) != 1 {
        return Err("the MP4 codec references external sample data".into());
    }
    if codec.kind == *b"mp4a" {
        audio_descriptors(file, codec, box_count)?;
    } else {
        let configuration = boxes(file, codec.content + 78, codec.end, box_count)?;
        required(&configuration, b"avcC")?;
    }
    let sizes = required(&tables, b"stsz")?;
    if sizes.end - sizes.content < 12 {
        return Err("the MP4 sample-size table is truncated".into());
    }
    let size = u32::from_be_bytes(read_at(file, sizes.content + 4)?);
    let count = table_count(file, sizes, 12, if size == 0 { 4 } else { 0 }, MAX_SAMPLES)?;
    if count == 0 {
        return Err("the MP4 contains an empty track".into());
    }
    Ok(count)
}

fn avc_nal_length(config: &[u8]) -> Result<usize, String> {
    if config.len() < 7
        || config[0] != 1
        || !matches!(config[1], 66 | 77 | 100)
        || !matches!(
            config[3],
            10 | 11 | 12 | 13 | 20 | 21 | 22 | 30 | 31 | 32 | 40 | 41 | 42 | 50 | 51
        )
        || config[4] & 0xfc != 0xfc
        || config[5] & 0xe0 != 0xe0
    {
        return Err("the MP4 requires H.264 Baseline, Main or High up to level 5.1".into());
    }
    let length = usize::from((config[4] & 3) + 1);
    if length == 3 || config[5] & 31 == 0 {
        return Err("the MP4 has an invalid H.264 configuration".into());
    }
    let mut offset = 6;
    for (count, kind) in [(config[5] & 31, 7), (0, 8)] {
        let count = if kind == 8 {
            let count = *config
                .get(offset)
                .ok_or("the MP4 is missing its H.264 picture parameters")?;
            offset += 1;
            count
        } else {
            count
        };
        if count == 0 {
            return Err("the MP4 is missing its H.264 parameter sets".into());
        }
        for _ in 0..count {
            let bytes = config
                .get(offset..offset + 2)
                .ok_or("the MP4 H.264 configuration is truncated")?;
            let size = usize::from(u16::from_be_bytes(
                bytes.try_into().expect("two NAL length bytes"),
            ));
            offset += 2;
            let nal = config
                .get(offset..offset + size)
                .ok_or("the MP4 H.264 parameter set is truncated")?;
            if nal.is_empty() || nal[0] & 0x80 != 0 || nal[0] & 31 != kind {
                return Err("the MP4 has an invalid H.264 parameter set".into());
            }
            if kind == 7 && (nal.len() < 4 || nal[1..4] != config[1..4]) {
                return Err("the MP4 H.264 sequence parameters disagree with its profile".into());
            }
            offset += size;
        }
    }
    if config[1] != 100 && offset != config.len() {
        return Err("the MP4 has unexpected H.264 configuration bytes".into());
    }
    if config[1] == 100 && offset != config.len() {
        let extra = config
            .get(offset..offset + 4)
            .ok_or("the MP4 High profile configuration is truncated")?;
        if extra[0] & 3 != 1
            || extra[1] & 7 != 0
            || extra[2] & 7 != 0
            || extra[3] != 0
            || offset + 4 != config.len()
        {
            return Err("the MP4 requires unsupported H.264 chroma or bit depth".into());
        }
    }
    Ok(length)
}

fn codec_nal_length(track: &Track) -> Result<Option<usize>, String> {
    let descriptions = &track
        .stsd
        .as_ref()
        .ok_or("the MP4 has no codec description")?
        .descriptions;
    match &descriptions[..] {
        [SampleEntry::Video(video)] if track.track_type == TrackType::Video => {
            if video.codec_type != CodecType::H264
                || !video.protection_info.is_empty()
                || video.width < 48
                || video.height < 48
                || video.width > 4096
                || video.height > 2304
            {
                return Err(
                    "the MP4 requires unencrypted H.264 video between 48x48 and 4096x2304".into(),
                );
            }
            let VideoCodecSpecific::AVCConfig(config) = &video.codec_specific else {
                return Err("the MP4 has no H.264 decoder configuration".into());
            };
            Ok(Some(avc_nal_length(config)?))
        }
        [SampleEntry::Audio(audio)] if track.track_type == TrackType::Audio => {
            let AudioCodecSpecific::ES_Descriptor(descriptor) = &audio.codec_specific else {
                return Err("the MP4 audio must use AAC LC".into());
            };
            let scalar_aac_config = match &descriptor.decoder_specific_data[..] {
                [first, second, ..] => {
                    first >> 3 == 2
                        && (3..=11).contains(&(((first & 7) << 1) | (second >> 7)))
                        && matches!((second >> 3) & 15, 1 | 2)
                        && second & 7 == 0
                }
                _ => false,
            };
            if audio.codec_type != CodecType::AAC
                || !audio.protection_info.is_empty()
                || descriptor.audio_object_type != Some(2)
                || descriptor.extended_audio_object_type.is_some()
                || !matches!(
                    descriptor.audio_sample_rate,
                    Some(8000 | 11025 | 12000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000)
                )
                || !matches!(descriptor.audio_channel_count, Some(1 | 2))
                || !scalar_aac_config
            {
                return Err("the MP4 audio requires mono or stereo AAC LC up to 48 kHz".into());
            }
            Ok(None)
        }
        _ => Err("the MP4 contains an unsupported track".into()),
    }
}

fn video_sample(
    file: &mut BufReader<File>,
    range: Range<u64>,
    nal_length: usize,
    total_nals: &mut usize,
    read_position: &mut u64,
) -> Result<(), String> {
    file.seek_relative(range.start as i64 - *read_position as i64)
        .map_err(|e| format!("could not seek to the MP4 video sample: {e}"))?;
    let mut offset = range.start;
    let mut has_picture = false;
    let mut sample_nals = 0;
    while offset < range.end {
        if sample_nals == MAX_NALS_PER_SAMPLE || *total_nals == MAX_VIDEO_NALS {
            return Err("the MP4 contains too many video NAL units to validate".into());
        }
        sample_nals += 1;
        *total_nals += 1;
        if range.end - offset <= nal_length as u64 {
            return Err("an MP4 H.264 sample has a truncated NAL length".into());
        }
        let mut length = [0; 4];
        file.read_exact(&mut length[4 - nal_length..])
            .map_err(|e| format!("could not read the MP4 video sample: {e}"))?;
        let mut nal_header = [0; 1];
        file.read_exact(&mut nal_header)
            .map_err(|e| format!("could not read the MP4 NAL header: {e}"))?;
        offset += nal_length as u64;
        let size = u32::from_be_bytes(length);
        if size == 0 || u64::from(size) > range.end - offset {
            return Err("an MP4 H.264 NAL unit extends outside its sample".into());
        }
        let header = nal_header[0];
        if header & 0x80 != 0 || !(1..=12).contains(&(header & 31)) {
            return Err("an MP4 H.264 sample has an invalid NAL unit".into());
        }
        has_picture |= matches!(header & 31, 1 | 5);
        file.seek_relative(i64::from(size) - 1)
            .map_err(|e| format!("could not skip the MP4 NAL body: {e}"))?;
        offset += u64::from(size);
    }
    if !has_picture {
        return Err("an MP4 video sample contains no picture data".into());
    }
    *read_position = range.end;
    Ok(())
}

fn track_samples(
    file: &mut BufReader<File>,
    track: &Track,
    count: u32,
    media: &[Range<u64>],
    nal_length: Option<usize>,
) -> Result<(), String> {
    let timescale = track.timescale.ok_or("the MP4 track has no timescale")?.0;
    let duration = track.duration.ok_or("the MP4 track has no duration")?.0;
    if timescale == 0 || duration == 0 {
        return Err("the MP4 track has no positive duration".into());
    }
    let timing = track
        .stts
        .as_ref()
        .ok_or("the MP4 track has no sample timing")?;
    let mut timed_count = 0u64;
    let mut timed_duration = 0u64;
    for run in &timing.samples {
        if run.sample_count == 0 || run.sample_delta == 0 {
            return Err("the MP4 has invalid sample timing".into());
        }
        timed_count += u64::from(run.sample_count);
        timed_duration = timed_duration
            .checked_add(u64::from(run.sample_count) * u64::from(run.sample_delta))
            .ok_or("the MP4 sample timing overflows")?;
    }
    // media_header_allows_one_clock_tick_of_timing_rounding covers integer clock rounding.
    if timed_count != u64::from(count) || timed_duration.abs_diff(duration) > 1 {
        return Err("the MP4 sample timing does not match its declared count and duration".into());
    }
    if let Some(composition) = &track.ctts {
        if composition.samples.iter().any(|run| run.sample_count == 0)
            || composition
                .samples
                .iter()
                .map(|run| u64::from(run.sample_count))
                .sum::<u64>()
                != u64::from(count)
        {
            return Err("the MP4 composition timing does not match its samples".into());
        }
    }
    if let Some(sync) = &track.stss {
        let mut previous = 0;
        for &sample in &sync.samples {
            if sample <= previous || sample > count {
                return Err("the MP4 has an invalid sync-sample index".into());
            }
            previous = sample;
        }
    }
    let sizes = track
        .stsz
        .as_ref()
        .ok_or("the MP4 track has no sample sizes")?;
    let offsets = &track
        .stco
        .as_ref()
        .ok_or("the MP4 track has no chunk offsets")?
        .offsets;
    let chunks = &track
        .stsc
        .as_ref()
        .ok_or("the MP4 track has no sample-to-chunk table")?
        .samples;
    if offsets.is_empty()
        || chunks.is_empty()
        || chunks[0].first_chunk != 1
        || sizes.sample_size == 0 && sizes.sample_sizes.len() != count as usize
    {
        return Err("the MP4 sample tables are incomplete".into());
    }
    let mut previous = 0;
    for run in chunks {
        if run.first_chunk <= previous
            || run.first_chunk as usize > offsets.len()
            || run.samples_per_chunk == 0
            || run.sample_description_index != 1
        {
            return Err("the MP4 sample-to-chunk table is invalid".into());
        }
        previous = run.first_chunk;
    }
    let mut sample = 0usize;
    let mut run = 0;
    let mut previous_end = 0;
    let mut total_nals = 0;
    let mut media_index = 0;
    let mut read_position = file
        .stream_position()
        .map_err(|e| format!("could not locate the MP4 sample reader: {e}"))?;
    for (index, &offset) in offsets.iter().enumerate() {
        if run + 1 < chunks.len() && index + 1 == chunks[run + 1].first_chunk as usize {
            run += 1;
        }
        let mut end = offset;
        if offset < previous_end {
            return Err("the MP4 has overlapping or reversed sample chunks".into());
        }
        for _ in 0..chunks[run].samples_per_chunk {
            if sample == count as usize {
                return Err("the MP4 chunks declare too many samples".into());
            }
            let size = if sizes.sample_size == 0 {
                sizes.sample_sizes[sample]
            } else {
                sizes.sample_size
            };
            let start = end;
            end = end
                .checked_add(u64::from(size))
                .ok_or("the MP4 sample offset overflows")?;
            while media_index < media.len() && media[media_index].end <= start {
                media_index += 1;
            }
            if size == 0
                || !media
                    .get(media_index)
                    .is_some_and(|range| start >= range.start && end <= range.end)
            {
                return Err("an MP4 sample points outside its media data".into());
            }
            if let Some(length) = nal_length {
                video_sample(
                    file,
                    start..end,
                    length,
                    &mut total_nals,
                    &mut read_position,
                )?;
            }
            sample += 1;
        }
        previous_end = end;
    }
    if sample != count as usize {
        return Err("the MP4 chunks do not contain all declared samples".into());
    }
    Ok(())
}

pub(crate) fn validate_mp4(path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| format!("could not read the MP4 movie: {e}"))?;
    let length = file
        .metadata()
        .map_err(|e| format!("could not inspect the MP4 movie: {e}"))?
        .len();
    if length == 0 || length > MAX_MOVIE_BYTES {
        return Err("the MP4 movie is empty or exceeds 512 MiB".into());
    }
    let mut box_count = 0;
    let entries = boxes(&mut file, 0, length, &mut box_count)?;
    let ftyp = required(&entries, b"ftyp")?;
    if ftyp.end - ftyp.content < 8
        || (ftyp.end - ftyp.content) % 4 != 0
        || ftyp.end - ftyp.content > 4096
    {
        return Err("the MP4 file-type box is invalid".into());
    }
    if entries
        .iter()
        .any(|entry| matches!(&entry.kind, b"moof" | b"mfra" | b"styp"))
    {
        return Err("fragmented MP4 movies are not supported".into());
    }
    let moov = required(&entries, b"moov")?;
    if moov.end - moov.start > MAX_METADATA_BYTES {
        return Err("the MP4 metadata exceeds 16 MiB".into());
    }
    let media: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == *b"mdat")
        .map(|entry| entry.content..entry.end)
        .collect();
    if media.is_empty() {
        return Err("the MP4 contains no media data".into());
    }
    let movie_children = boxes(&mut file, moov.content, moov.end, &mut box_count)?;
    required(&movie_children, b"mvhd")?;
    if movie_children
        .iter()
        .any(|entry| matches!(&entry.kind, b"mvex" | b"pssh"))
    {
        return Err("fragmented or protected MP4 movies are not supported".into());
    }
    let tracks: Vec<_> = movie_children
        .iter()
        .filter(|entry| entry.kind == *b"trak")
        .collect();
    if tracks.is_empty() || tracks.len() > 2 {
        return Err("the MP4 requires one video track and at most one audio track".into());
    }
    let counts = tracks
        .iter()
        .map(|track| track_sample_count(&mut file, track, &mut box_count))
        .collect::<Result<Vec<_>, _>>()?;
    file.seek(SeekFrom::Start(moov.start))
        .map_err(|e| e.to_string())?;
    let context = mp4parse::read_mp4(&mut (&mut file).take(moov.end - moov.start))
        .map_err(|e| format!("the MP4 metadata is invalid: {e}"))?;
    let mut video_count = 0;
    let mut audio_count = 0;
    let mut ids = HashSet::new();
    if context.tracks.len() != counts.len() {
        return Err("the MP4 metadata does not describe every track".into());
    }
    let mut file = BufReader::new(file);
    for (track, count) in context.tracks.iter().zip(counts) {
        let id = track.track_id.ok_or("the MP4 track has no ID")?;
        if id == 0 || !ids.insert(id) {
            return Err("the MP4 repeats a track ID or uses the reserved zero ID".into());
        }
        let nal_length = codec_nal_length(track)?;
        video_count += usize::from(nal_length.is_some());
        audio_count += usize::from(nal_length.is_none());
        if video_count > 1 || audio_count > 1 {
            return Err("the MP4 repeats its video or audio track".into());
        }
        track_samples(&mut file, track, count, &media, nal_length)?;
    }
    if video_count != 1 {
        return Err(
            "the MP4 requires one H.264 video track and at most one AAC LC audio track".into(),
        );
    }
    Ok(())
}

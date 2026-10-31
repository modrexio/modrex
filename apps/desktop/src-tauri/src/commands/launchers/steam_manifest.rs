#[cfg(windows)]
use super::native_paths::validate_windows_paths;
use super::native_paths::{
    normalize_native_path, read_bounded, CatalogSource, NativePaths, MAX_PATH_BYTES,
};
use crate::commands::path_display::display_path;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_APPSTATE_BYTES: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 256 * 1024 * 1024;
const MAX_MAPPINGS: usize = 1_000_000;
const MAX_DEPOTS: usize = 256;
const PAYLOAD_MAGIC: u32 = 0x71f617d0;
const METADATA_MAGIC: u32 = 0x1f4812be;
const SIGNATURE_MAGIC: u32 = 0x1b81b817;
const END_MAGIC: u32 = 0x32c415ab;
const DIRECTORY_FLAG: u32 = 64;
const SYMLINK_FLAG: u32 = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstalledDepot {
    pub depot_id: u32,
    pub manifest_id: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeFilesSnapshot {
    pub game_root: PathBuf,
    pub app_id: u32,
    pub build_id: u64,
    pub depots: Vec<InstalledDepot>,
    pub native: NativePaths,
    selected_game_root: PathBuf,
    selected_cache_root: PathBuf,
    cache_root: PathBuf,
    sources: Vec<CatalogSource>,
}

impl NativeFilesSnapshot {
    pub(crate) fn protects(&self, relative: &Path) -> Result<bool, String> {
        self.native.protects(relative)
    }

    pub(crate) fn protects_tree(&self, relative: &Path) -> Result<bool, String> {
        self.native.protects_tree(relative)
    }

    /// Rechecks the exact AppState and depot bytes before committing a filesystem mutation.
    pub(crate) fn verify_unchanged(&self) -> Result<(), String> {
        let root = fs::canonicalize(&self.selected_game_root)
            .map_err(|e| format!("Could not recheck Steam installation root: {e}"))?;
        if root != self.game_root {
            return Err("Steam installation root changed during the operation".into());
        }
        let cache = fs::canonicalize(&self.selected_cache_root)
            .map_err(|e| format!("Could not recheck primary Steam depotcache: {e}"))?;
        if cache != self.cache_root {
            return Err("Primary Steam depotcache changed during the operation".into());
        }
        self.sources
            .iter()
            .try_for_each(CatalogSource::verify_unchanged)
    }
}

/// Loads every locally selected depot from the primary Steam installation's cache.
pub(crate) fn read_native_files(
    steam_root: &Path,
    game_root: &Path,
    app_id: u32,
) -> Result<NativeFilesSnapshot, String> {
    if app_id == 0 {
        return Err("Steam native-file catalog requires a nonzero app ID".into());
    }
    let selected_game_root = std::path::absolute(game_root)
        .map_err(|e| format!("Could not resolve selected Steam path: {e}"))?;
    let game_root = fs::canonicalize(&selected_game_root)
        .map_err(|e| format!("Could not resolve Steam installation root: {e}"))?;
    if !fs::metadata(&game_root)
        .map_err(|e| format!("Could not inspect Steam installation root: {e}"))?
        .is_dir()
    {
        return Err("Steam installation root is not a directory".into());
    }
    let (common, steamapps) = steam_library_parts(&game_root)
        .ok_or("Steam native-file catalog requires a steamapps/common installation")?;
    let appmanifest = steamapps.join(format!("appmanifest_{app_id}.acf"));
    let app_bytes = read_bounded(&appmanifest, MAX_APPSTATE_BYTES)?;
    let app = parse_appstate(&app_bytes, app_id)
        .map_err(|e| format!("Invalid Steam AppState {}: {e}", display_path(&appmanifest)))?;
    let declared_root = fs::canonicalize(common.join(&app.install_dir))
        .map_err(|e| format!("Could not resolve AppState installation directory: {e}"))?;
    if declared_root != game_root {
        return Err(
            "Steam AppState installation directory does not match the selected game".into(),
        );
    }
    let selected_cache_root = std::path::absolute(steam_root.join("depotcache"))
        .map_err(|e| format!("Could not resolve primary Steam depotcache path: {e}"))?;
    let cache = fs::canonicalize(&selected_cache_root)
        .map_err(|e| format!("Could not resolve primary Steam depotcache: {e}"))?;
    let mut sources = vec![CatalogSource::new(
        appmanifest,
        &app_bytes,
        MAX_APPSTATE_BYTES,
    )];
    let mut native_paths = BTreeMap::<String, String>::new();
    let mut catalog_bytes = 0usize;
    for depot in &app.depots {
        let path = cache.join(format!(
            "{}_{}.manifest",
            depot.identity.depot_id, depot.identity.manifest_id
        ));
        let bytes = read_bounded(&path, MAX_MANIFEST_BYTES)?;
        catalog_bytes = catalog_bytes
            .checked_add(bytes.len())
            .filter(|&total| total <= MAX_CATALOG_BYTES)
            .ok_or("Steam native-file catalog exceeds the byte limit")?;
        let manifest = parse_depot_manifest(&bytes, &depot.identity)
            .map_err(|e| format!("Invalid Steam depot manifest {}: {e}", display_path(&path)))?;
        if depot.size.is_some_and(|size| size != manifest.size) {
            return Err(format!(
                "Steam depot {} size does not match AppState",
                depot.identity.depot_id
            ));
        }
        for (normalized, spelling) in manifest.files {
            if let Some(existing) = native_paths.get(&normalized) {
                if existing != &spelling {
                    return Err(format!(
                        "Steam depots contain a path case collision: {spelling}"
                    ));
                }
                continue;
            }
            if native_paths.len() >= MAX_MAPPINGS {
                return Err("Steam native-file catalog exceeds the path count limit".into());
            }
            native_paths.insert(normalized, spelling);
        }
        sources.push(CatalogSource::new(path, &bytes, MAX_MANIFEST_BYTES));
    }
    let snapshot = NativeFilesSnapshot {
        game_root,
        app_id,
        build_id: app.build_id,
        depots: app.depots.into_iter().map(|depot| depot.identity).collect(),
        selected_game_root,
        selected_cache_root,
        cache_root: cache,
        sources,
        native: NativePaths::new(native_paths)?,
    };
    snapshot.verify_unchanged()?;
    Ok(snapshot)
}

/// Recognizes an installation from AppState without depending on the depot cache.
pub(crate) fn matches_installation(game_root: &Path, app_id: u32) -> Result<bool, String> {
    if app_id == 0 {
        return Err("Steam installation recognition requires a nonzero app ID".into());
    }
    let game_root = match fs::canonicalize(game_root) {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not resolve Steam installation root: {error}"
            ))
        }
    };
    if !fs::metadata(&game_root)
        .map_err(|e| format!("Could not inspect Steam installation root: {e}"))?
        .is_dir()
    {
        return Ok(false);
    }
    let Some((common, steamapps)) = steam_library_parts(&game_root) else {
        return Ok(false);
    };
    let path = steamapps.join(format!("appmanifest_{app_id}.acf"));
    match fs::metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not inspect Steam AppState {}: {error}",
                display_path(&path)
            ))
        }
    }
    let bytes = read_bounded(&path, MAX_APPSTATE_BYTES)?;
    let entries = parse_app_entries(&bytes)
        .map_err(|e| format!("Invalid Steam AppState {}: {e}", display_path(&path)))?;
    if kv_number(&entries, "appid")? != u64::from(app_id) {
        return Err("Steam AppState app ID does not match its filename".into());
    }
    let install_dir = kv_text(&entries, "installdir")?;
    validate_install_dir(install_dir)?;
    let declared_root = fs::canonicalize(common.join(install_dir))
        .map_err(|e| format!("Could not resolve AppState installation directory: {e}"))?;
    Ok(declared_root == game_root)
}

fn steam_library_parts(game_root: &Path) -> Option<(&Path, &Path)> {
    let common = game_root.parent()?;
    let steamapps = common.parent()?;
    if !common.file_name()?.to_str()?.eq_ignore_ascii_case("common")
        || !steamapps
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case("steamapps")
    {
        return None;
    }
    Some((common, steamapps))
}

#[derive(Debug)]
enum KeyValue {
    Text(String),
    Object(BTreeMap<String, KeyValue>),
}

struct KeyValuesReader<'a> {
    bytes: &'a [u8],
    cursor: usize,
    entries: usize,
}

impl KeyValuesReader<'_> {
    fn whitespace(&mut self) {
        loop {
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(u8::is_ascii_whitespace)
            {
                self.cursor += 1;
            }
            if self.bytes.get(self.cursor..self.cursor + 2) != Some(b"//") {
                return;
            }
            while self.bytes.get(self.cursor).is_some_and(|&c| c != b'\n') {
                self.cursor += 1;
            }
        }
    }

    fn quoted(&mut self) -> Result<String, String> {
        self.whitespace();
        if self.bytes.get(self.cursor) != Some(&b'"') {
            return Err("Expected a quoted KeyValues string".into());
        }
        self.cursor += 1;
        let mut value = Vec::new();
        while let Some(&byte) = self.bytes.get(self.cursor) {
            self.cursor += 1;
            if byte == b'"' {
                return String::from_utf8(value).map_err(|_| "Invalid KeyValues UTF-8".into());
            }
            let decoded = match byte {
                b'\\' => {
                    let escaped = *self
                        .bytes
                        .get(self.cursor)
                        .ok_or("Truncated KeyValues escape")?;
                    self.cursor += 1;
                    match escaped {
                        b'"' | b'\\' => escaped,
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        _ => return Err("Unsupported KeyValues escape".into()),
                    }
                }
                0 => return Err("KeyValues contains a null byte".into()),
                _ => byte,
            };
            value.push(decoded);
            if value.len() > MAX_PATH_BYTES {
                return Err("KeyValues string exceeds the length limit".into());
            }
        }
        Err("Unterminated KeyValues string".into())
    }

    fn object(&mut self, depth: usize) -> Result<BTreeMap<String, KeyValue>, String> {
        if depth > 16 {
            return Err("KeyValues exceeds the nesting limit".into());
        }
        self.whitespace();
        if self.bytes.get(self.cursor) != Some(&b'{') {
            return Err("Expected a KeyValues object".into());
        }
        self.cursor += 1;
        let mut entries = BTreeMap::new();
        loop {
            self.whitespace();
            if self.bytes.get(self.cursor) == Some(&b'}') {
                self.cursor += 1;
                return Ok(entries);
            }
            self.entries += 1;
            if self.entries > 50_000 {
                return Err("KeyValues exceeds the entry count limit".into());
            }
            let key = self.quoted()?;
            self.whitespace();
            let value = match self.bytes.get(self.cursor) {
                Some(b'{') => KeyValue::Object(self.object(depth + 1)?),
                Some(b'"') => KeyValue::Text(self.quoted()?),
                _ => return Err("Missing KeyValues value".into()),
            };
            if entries.insert(key.to_ascii_lowercase(), value).is_some() {
                return Err(format!("Duplicate KeyValues key: {key}"));
            }
        }
    }
}

struct AppDepot {
    identity: InstalledDepot,
    size: Option<u64>,
}

struct AppState {
    install_dir: String,
    build_id: u64,
    depots: Vec<AppDepot>,
}

fn kv_text<'a>(entries: &'a BTreeMap<String, KeyValue>, key: &str) -> Result<&'a str, String> {
    match entries.get(key) {
        Some(KeyValue::Text(value)) => Ok(value),
        _ => Err(format!("Missing Steam AppState string: {key}")),
    }
}

fn kv_number(entries: &BTreeMap<String, KeyValue>, key: &str) -> Result<u64, String> {
    decimal(kv_text(entries, key)?, key)
}

fn decimal(value: &str, field: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("Invalid Steam numeric field: {field}"));
    }
    value
        .parse()
        .map_err(|_| format!("Steam numeric field exceeds uint64: {field}"))
}

fn parse_app_entries(bytes: &[u8]) -> Result<BTreeMap<String, KeyValue>, String> {
    if bytes.len() > MAX_APPSTATE_BYTES {
        return Err("Steam AppState exceeds the byte limit".into());
    }
    let mut reader = KeyValuesReader {
        bytes,
        cursor: 0,
        entries: 0,
    };
    if !reader.quoted()?.eq_ignore_ascii_case("AppState") {
        return Err("Missing Steam AppState root".into());
    }
    let entries = reader.object(0)?;
    reader.whitespace();
    if reader.cursor != bytes.len() {
        return Err("Trailing Steam AppState data".into());
    }
    Ok(entries)
}

fn validate_install_dir(install_dir: &str) -> Result<(), String> {
    normalize_native_path(install_dir)?;
    if install_dir.contains(['/', '\\']) {
        return Err("Steam AppState installation directory is not a single folder".into());
    }
    Ok(())
}

fn parse_appstate(bytes: &[u8], app_id: u32) -> Result<AppState, String> {
    let entries = parse_app_entries(bytes)?;
    if kv_number(&entries, "appid")? != u64::from(app_id) {
        return Err("Steam AppState app ID does not match the selected game".into());
    }
    // InstalledDepots protects the installed build while a Steam update is pending.
    let state_flags = kv_number(&entries, "stateflags")?;
    if !matches!(state_flags, 4 | 6) {
        return Err("Steam installation is not fully installed or is being updated".into());
    }
    if state_flags == 6 {
        match entries.get("stageddepots") {
            None => {}
            Some(KeyValue::Object(depots)) if depots.is_empty() => {}
            Some(KeyValue::Object(_)) => {
                return Err("Steam installation has staged depots awaiting an update".into());
            }
            Some(_) => return Err("Steam AppState StagedDepots is not an object".into()),
        }
    }
    let build_id = kv_number(&entries, "buildid")?;
    if build_id == 0 {
        return Err("Steam AppState has no installed build".into());
    }
    if entries.contains_key("targetbuildid")
        && kv_number(&entries, "targetbuildid")? != build_id
        && state_flags != 6
    {
        return Err("Steam installation target build differs from the installed build".into());
    }
    if entries.contains_key("updateresult") && kv_number(&entries, "updateresult")? != 0 {
        return Err("Steam AppState reports an unsuccessful update".into());
    }
    let install_dir = kv_text(&entries, "installdir")?.to_string();
    validate_install_dir(&install_dir)?;
    let installed = match entries.get("installeddepots") {
        Some(KeyValue::Object(depots)) => depots,
        _ => return Err("Steam AppState has no InstalledDepots catalog".into()),
    };
    if installed.is_empty() || installed.len() > MAX_DEPOTS {
        return Err("Steam InstalledDepots is empty or exceeds the depot count limit".into());
    }
    let mut depots = Vec::new();
    let mut seen = BTreeSet::new();
    for (key, value) in installed {
        let depot_id = u32::try_from(decimal(key, "depot ID")?)
            .map_err(|_| "Steam depot ID exceeds uint32")?;
        if depot_id == 0 || !seen.insert(depot_id) {
            return Err("Steam InstalledDepots contains a zero or duplicate depot ID".into());
        }
        let fields = match value {
            KeyValue::Object(fields) => fields,
            _ => return Err("Steam InstalledDepots entry is not an object".into()),
        };
        let manifest_id = kv_number(fields, "manifest")?;
        if manifest_id == 0 {
            return Err("Steam InstalledDepots contains a zero manifest ID".into());
        }
        let size = fields
            .contains_key("size")
            .then(|| kv_number(fields, "size"))
            .transpose()?;
        depots.push(AppDepot {
            identity: InstalledDepot {
                depot_id,
                manifest_id,
            },
            size,
        });
    }
    Ok(AppState {
        install_dir,
        build_id,
        depots,
    })
}

#[derive(Clone, Copy)]
enum ProtoValue<'a> {
    Integer(u64),
    Bytes(&'a [u8]),
    Fixed32,
    Fixed64,
}

struct ProtoReader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> ProtoReader<'a> {
    fn varint(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let byte = *self
                .bytes
                .get(self.cursor)
                .ok_or("Truncated protobuf varint")?;
            self.cursor += 1;
            if shift == 63 && byte > 1 {
                return Err("Protobuf varint exceeds uint64".into());
            }
            value |= u64::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(value);
            }
        }
        Err("Protobuf varint exceeds uint64".into())
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .cursor
            .checked_add(length)
            .ok_or("Protobuf length overflow")?;
        let value = self
            .bytes
            .get(self.cursor..end)
            .ok_or("Truncated protobuf field")?;
        self.cursor = end;
        Ok(value)
    }

    fn next(&mut self) -> Result<Option<(u32, ProtoValue<'a>)>, String> {
        if self.cursor == self.bytes.len() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let field = tag >> 3;
        if field == 0 || field > 0x1fff_ffff {
            return Err("Invalid protobuf field number".into());
        }
        let value = match tag & 7 {
            0 => ProtoValue::Integer(self.varint()?),
            1 => {
                self.take(8)?;
                ProtoValue::Fixed64
            }
            2 => {
                let length =
                    usize::try_from(self.varint()?).map_err(|_| "Protobuf length overflow")?;
                ProtoValue::Bytes(self.take(length)?)
            }
            5 => {
                self.take(4)?;
                ProtoValue::Fixed32
            }
            _ => return Err("Unsupported protobuf wire type".into()),
        };
        Ok(Some((field as u32, value)))
    }
}

fn proto_bytes(value: ProtoValue<'_>) -> Result<&[u8], String> {
    match value {
        ProtoValue::Bytes(bytes) => Ok(bytes),
        _ => Err("Unexpected protobuf wire type for bytes".into()),
    }
}

fn proto_integer(value: ProtoValue<'_>) -> Result<u64, String> {
    match value {
        ProtoValue::Integer(value) => Ok(value),
        _ => Err("Unexpected protobuf wire type for integer".into()),
    }
}

fn scalar_fields(bytes: &[u8], maximum: u32) -> Result<BTreeMap<u32, u64>, String> {
    let mut reader = ProtoReader { bytes, cursor: 0 };
    let mut fields = BTreeMap::new();
    while let Some((field, value)) = reader.next()? {
        if field > maximum {
            continue;
        }
        if fields.insert(field, proto_integer(value)?).is_some() {
            return Err("Duplicate protobuf scalar field".into());
        }
    }
    Ok(fields)
}

fn little_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor
        .checked_add(4)
        .ok_or("Manifest section length overflow")?;
    let value = bytes
        .get(*cursor..end)
        .ok_or("Truncated manifest section header")?;
    *cursor = end;
    Ok(u32::from_le_bytes(
        value.try_into().expect("A section integer has four bytes"),
    ))
}

#[derive(Debug)]
struct DepotFiles {
    files: BTreeMap<String, String>,
    size: u64,
}

// SteamKit's DepotManifest and SteamTracking's content_manifest.proto define
// these section markers and fields. SteamKit saves an empty signature section
// in decrypted cache manifests, so CRC and identity checks are not signature authentication.
fn parse_depot_manifest(bytes: &[u8], expected: &InstalledDepot) -> Result<DepotFiles, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("Steam depot manifest exceeds the byte limit".into());
    }
    let mut cursor = 0;
    let mut sections = BTreeMap::new();
    loop {
        let magic = little_u32(bytes, &mut cursor)?;
        if magic == END_MAGIC {
            break;
        }
        if !matches!(magic, PAYLOAD_MAGIC | METADATA_MAGIC | SIGNATURE_MAGIC) {
            return Err("Unrecognized Steam depot manifest section".into());
        }
        let length = little_u32(bytes, &mut cursor)? as usize;
        let end = cursor
            .checked_add(length)
            .ok_or("Manifest section length overflow")?;
        let section = bytes.get(cursor..end).ok_or("Truncated manifest section")?;
        if sections.insert(magic, section).is_some() {
            return Err("Duplicate Steam depot manifest section".into());
        }
        cursor = end;
    }
    if cursor != bytes.len() || sections.len() != 3 {
        return Err("Steam depot manifest is incomplete or has trailing data".into());
    }
    let metadata = scalar_fields(sections[&METADATA_MAGIC], 9)?;
    if metadata.get(&1) != Some(&u64::from(expected.depot_id))
        || metadata.get(&2) != Some(&expected.manifest_id)
    {
        return Err("Steam depot or manifest identity mismatch".into());
    }
    if metadata.get(&4).copied().unwrap_or(0) != 0 {
        return Err("Steam depot manifest filenames are encrypted".into());
    }
    for field in [1, 3, 7, 8, 9] {
        if metadata
            .get(&field)
            .is_some_and(|&value| value > u64::from(u32::MAX))
        {
            return Err("Steam manifest metadata exceeds uint32".into());
        }
    }
    let payload = sections[&PAYLOAD_MAGIC];
    let expected_crc = metadata
        .get(&9)
        .ok_or("Steam manifest has no clear payload CRC")?;
    if *expected_crc != u64::from(payload_crc(payload)) {
        return Err("Steam manifest clear payload CRC mismatch".into());
    }
    validate_signature(sections[&SIGNATURE_MAGIC])?;
    let files = parse_mappings(payload)?;
    if metadata.get(&5) != Some(&files.size) {
        return Err("Steam manifest file sizes do not match the declared depot size".into());
    }
    Ok(files)
}

fn validate_signature(bytes: &[u8]) -> Result<(), String> {
    let mut reader = ProtoReader { bytes, cursor: 0 };
    let mut seen = false;
    while let Some((field, value)) = reader.next()? {
        if field != 1 {
            continue;
        }
        proto_bytes(value)?;
        if seen {
            return Err("Duplicate Steam manifest signature field".into());
        }
        seen = true;
    }
    Ok(())
}

fn parse_mappings(payload: &[u8]) -> Result<DepotFiles, String> {
    let mut reader = ProtoReader {
        bytes: payload,
        cursor: 0,
    };
    let mut all_paths = BTreeMap::<String, (String, bool)>::new();
    let mut size = 0u64;
    while let Some((field, value)) = reader.next()? {
        if field != 1 {
            continue;
        }
        if all_paths.len() >= MAX_MAPPINGS {
            return Err("Steam manifest exceeds the mapping count limit".into());
        }
        let (name, file_size, directory) = parse_mapping(proto_bytes(value)?)?;
        let normalized = normalize_native_path(&name)?;
        let spelling = name.replace('\\', "/");
        if all_paths
            .insert(normalized, (spelling, directory))
            .is_some()
        {
            return Err(format!(
                "Duplicate or case-colliding Steam manifest path: {name}"
            ));
        }
        size = size
            .checked_add(file_size)
            .ok_or("Steam manifest total file size overflow")?;
    }
    for path in all_paths.keys() {
        for (position, _) in path.match_indices('/') {
            if all_paths
                .get(&path[..position])
                .is_some_and(|(_, directory)| !directory)
            {
                return Err(format!(
                    "Steam manifest file is also a parent directory: {path}"
                ));
            }
        }
    }
    #[cfg(windows)]
    validate_windows_paths(
        all_paths
            .values()
            .map(|(path, directory)| (path.as_str(), *directory)),
    )?;
    let files = all_paths
        .into_iter()
        .filter(|(_, (_, directory))| !directory)
        .map(|(path, (spelling, _))| (path, spelling))
        .collect();
    Ok(DepotFiles { files, size })
}

fn parse_mapping(bytes: &[u8]) -> Result<(String, u64, bool), String> {
    let mut reader = ProtoReader { bytes, cursor: 0 };
    let mut seen = BTreeSet::new();
    let mut name = None;
    let mut size = 0;
    let mut flags = 0;
    while let Some((field, value)) = reader.next()? {
        if field <= 7 && field != 6 && !seen.insert(field) {
            return Err("Duplicate Steam file mapping field".into());
        }
        match field {
            1 => {
                let bytes = proto_bytes(value)?;
                if bytes.len() > MAX_PATH_BYTES {
                    return Err("Steam manifest filename exceeds the length limit".into());
                }
                name = Some(
                    std::str::from_utf8(bytes)
                        .map_err(|_| "Invalid Steam filename UTF-8")?
                        .to_string(),
                );
            }
            2 => size = proto_integer(value)?,
            3 => {
                flags = u32::try_from(proto_integer(value)?)
                    .map_err(|_| "Steam file flags exceed uint32")?
            }
            4 | 5 => {
                let hash = proto_bytes(value)?;
                if !hash.is_empty() && hash.len() != 20 {
                    return Err("Invalid Steam file SHA1 length".into());
                }
            }
            6 => validate_chunk(proto_bytes(value)?)?,
            7 if !proto_bytes(value)?.is_empty() => {
                return Err("Steam manifest link targets are unsupported".into());
            }
            _ => {}
        }
    }
    if flags & SYMLINK_FLAG != 0 {
        return Err("Steam manifest symbolic links are unsupported".into());
    }
    let directory = flags & DIRECTORY_FLAG != 0;
    if directory && size != 0 {
        return Err("Steam directory mapping has a nonzero file size".into());
    }
    Ok((
        name.ok_or("Steam file mapping has no filename")?,
        size,
        directory,
    ))
}

fn validate_chunk(bytes: &[u8]) -> Result<(), String> {
    let mut reader = ProtoReader { bytes, cursor: 0 };
    let mut seen = BTreeSet::new();
    while let Some((field, value)) = reader.next()? {
        if field <= 5 && !seen.insert(field) {
            return Err("Duplicate Steam chunk field".into());
        }
        match field {
            1 => {
                if proto_bytes(value)?.len() != 20 {
                    return Err("Invalid Steam chunk SHA1 length".into());
                }
            }
            2 => {
                if !matches!(value, ProtoValue::Fixed32) {
                    return Err("Invalid Steam chunk CRC wire type".into());
                }
            }
            3 => {
                proto_integer(value)?;
            }
            4 | 5 => {
                u32::try_from(proto_integer(value)?)
                    .map_err(|_| "Steam chunk size exceeds uint32")?;
            }
            _ => {}
        }
    }
    Ok(())
}

// SteamKit serializes the little-endian payload length before calculating CRC32.
fn payload_crc(payload: &[u8]) -> u32 {
    let mut crc = crc32fast::Hasher::new();
    crc.update(&(payload.len() as u32).to_le_bytes());
    crc.update(payload);
    crc.finalize()
}

#[cfg(test)]
#[path = "steam_manifest_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::write_test_catalog;

//! Engine.ini text handling: byte-preserving decode and encode, and the scalar preset merge.
//!
//! Supported encodings are pure ASCII without a BOM, and UTF-8, UTF-16LE or UTF-16BE with a
//! BOM. Unmarked non-ASCII bytes are refused rather than guessed, since a strict UTF-8 decode
//! does not prove the file was written as UTF-8. Line endings must be uniform. The editor's
//! textarea normalizes them to LF, so the original style is restored on save.
//!
//! The merge never rebuilds a document from a map. Unreal config allows repeated sections,
//! repeated keys and the array operators +, -, . and !, so only assignments that are
//! unambiguous on both sides are applied automatically, and every other byte is kept.

use super::resource_state::KeyChange;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encoding {
    Ascii,
    Utf8Bom,
    Utf16LeBom,
    Utf16BeBom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineEnding {
    Crlf,
    Lf,
    /// The file has no line break at all, so it states no style.
    None,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Decoded {
    pub encoding: Encoding,
    pub eol: LineEnding,
    /// The text with line breaks normalized to LF, as a textarea would hold it.
    pub text: String,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let (encoding, raw) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        let text = std::str::from_utf8(rest)
            .map_err(|_| "the file has a UTF-8 marker but is not valid UTF-8".to_string())?;
        (Encoding::Utf8Bom, text.to_string())
    } else if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (
            Encoding::Utf16LeBom,
            decode_utf16(rest, u16::from_le_bytes)?,
        )
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (
            Encoding::Utf16BeBom,
            decode_utf16(rest, u16::from_be_bytes)?,
        )
    } else if bytes.is_ascii() {
        (
            Encoding::Ascii,
            String::from_utf8(bytes.to_vec()).expect("ASCII is UTF-8"),
        )
    } else {
        return Err("the file contains non-ASCII text without an encoding marker, so its encoding cannot be known; Modrex will not guess".to_string());
    };
    if raw
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("the file contains binary control characters".into());
    }
    let eol = line_ending(&raw);
    Ok(Decoded {
        encoding,
        eol,
        text: raw.replace("\r\n", "\n"),
    })
}

fn decode_utf16(bytes: &[u8], read: fn([u8; 2]) -> u16) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("the file has a UTF-16 marker but an odd byte length".to_string());
    }
    let units = bytes.chunks_exact(2).map(|c| read([c[0], c[1]]));
    char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .map_err(|_| "the file has a UTF-16 marker but contains invalid UTF-16".to_string())
}

fn line_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let cr = text.matches('\r').count();
    let lf = text.matches('\n').count();
    match (crlf, cr, lf) {
        (0, 0, 0) => LineEnding::None,
        (0, 0, _) => LineEnding::Lf,
        (n, c, l) if n == c && n == l => LineEnding::Crlf,
        _ => LineEnding::Mixed,
    }
}

/// Encodes textarea text back in the original file's encoding and line-ending style.
///
/// A file with no line break of its own gets CRLF, the style Unreal writes on Windows.
pub(crate) fn encode(text: &str, encoding: Encoding, eol: LineEnding) -> Result<Vec<u8>, String> {
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err("the text contains binary control characters".into());
    }
    if text.contains('\r') {
        return Err("the text contains a carriage return the editor cannot represent".to_string());
    }
    let text =
        match eol {
            LineEnding::Mixed => return Err(
                "the file mixes line-ending styles, so saving would change lines you did not edit"
                    .to_string(),
            ),
            LineEnding::Lf => text.to_string(),
            LineEnding::Crlf | LineEnding::None => text.replace('\n', "\r\n"),
        };
    Ok(match encoding {
        Encoding::Ascii => {
            if !text.is_ascii() {
                return Err(
                    "the file is plain ASCII; saving non-ASCII text would change its encoding"
                        .to_string(),
                );
            }
            text.into_bytes()
        }
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        Encoding::Utf16LeBom => [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect(),
        Encoding::Utf16BeBom => [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LineKind {
    Blank,
    Comment,
    Section(String),
    /// op is one of + - . ! when present. eq is the byte index of the = sign.
    Key {
        op: Option<char>,
        name: String,
        value: String,
        eq: usize,
    },
    /// An operator line without = (for example a bare !Key), which still names a key.
    OperatorOnly {
        op: char,
        name: String,
    },
    Other,
}

fn classify(line: &str) -> LineKind {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return LineKind::Blank;
    }
    if trimmed.starts_with(';') || trimmed.starts_with('#') {
        return LineKind::Comment;
    }
    if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() >= 2 {
        return LineKind::Section(trimmed[1..trimmed.len() - 1].to_string());
    }
    let op = trimmed
        .chars()
        .next()
        .filter(|c| matches!(c, '+' | '-' | '.' | '!'));
    let Some(eq) = line.find('=') else {
        return match op {
            Some(op) => LineKind::OperatorOnly {
                op,
                name: trimmed[1..].trim().to_string(),
            },
            None => LineKind::Other,
        };
    };
    let key_part = line[..eq].trim();
    let name = match op {
        Some(_) => key_part[1..].trim(),
        None => key_part,
    };
    if name.is_empty() {
        return LineKind::Other;
    }
    LineKind::Key {
        op,
        name: name.to_string(),
        value: line[eq + 1..].trim().to_string(),
        eq,
    }
}

/// A document split into lines, remembering whether the last line was terminated.
struct Doc {
    lines: Vec<String>,
    terminated: bool,
}

impl Doc {
    fn parse(text: &str) -> Self {
        if text.is_empty() {
            return Self {
                lines: Vec::new(),
                terminated: false,
            };
        }
        let terminated = text.ends_with('\n');
        let body = text.strip_suffix('\n').unwrap_or(text);
        Self {
            lines: body.split('\n').map(String::from).collect(),
            terminated,
        }
    }

    fn render(&self) -> String {
        let mut out = self.lines.join("\n");
        if self.terminated && !self.lines.is_empty() {
            out.push('\n');
        }
        out
    }

    /// Header line indices of sections matching name, case-insensitively.
    fn sections(&self, name: &str) -> Vec<usize> {
        self.lines
            .iter()
            .enumerate()
            .filter(|(_, l)| matches!(classify(l), LineKind::Section(s) if s.eq_ignore_ascii_case(name)))
            .map(|(i, _)| i)
            .collect()
    }

    /// The line range of the section body starting after header.
    fn body(&self, header: usize) -> std::ops::Range<usize> {
        let end = (header + 1..self.lines.len())
            .find(|&i| matches!(classify(&self.lines[i]), LineKind::Section(_)))
            .unwrap_or(self.lines.len());
        header + 1..end
    }

    /// Every line in range that declares key, with or without an operator.
    fn declarations(&self, range: std::ops::Range<usize>, key: &str) -> Vec<(usize, LineKind)> {
        range
            .filter_map(|i| {
                let kind = classify(&self.lines[i]);
                let named = match &kind {
                    LineKind::Key { name, .. } | LineKind::OperatorOnly { name, .. } => {
                        name.eq_ignore_ascii_case(key)
                    }
                    _ => false,
                };
                named.then_some((i, kind))
            })
            .collect()
    }
}

/// The state of one setting: absent, set to a value, or not a single plain assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Setting {
    Absent { section_header: Option<usize> },
    Value { line: usize, value: String },
    Ambiguous,
}

fn setting(doc: &Doc, section: &str, key: &str) -> Setting {
    let headers = doc.sections(section);
    let header = match headers.as_slice() {
        [] => {
            return Setting::Absent {
                section_header: None,
            }
        }
        [one] => *one,
        _ => return Setting::Ambiguous,
    };
    let decls = doc.declarations(doc.body(header), key);
    match decls.as_slice() {
        [] => Setting::Absent {
            section_header: Some(header),
        },
        [(
            line,
            LineKind::Key {
                op: None, value, ..
            },
        )] => Setting::Value {
            line: *line,
            value: value.clone(),
        },
        _ => Setting::Ambiguous,
    }
}

/// One section/key=value of a preset source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Assignment {
    pub section: String,
    pub key: String,
    pub value: String,
}

/// Reads a preset source as plain scalar assignments, or explains why it is outside that
/// subset and needs a deliberate edit in the raw editor instead.
pub(crate) fn scalar_assignments(text: &str) -> Result<Vec<Assignment>, String> {
    let mut out: Vec<Assignment> = Vec::new();
    let mut seen_sections: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        match classify(line) {
            LineKind::Blank | LineKind::Comment => {}
            LineKind::Section(name) => {
                if seen_sections.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                    return Err(format!("section [{name}] appears more than once"));
                }
                seen_sections.push(name.clone());
                current = Some(name);
            }
            LineKind::Key {
                op: Some(op), name, ..
            }
            | LineKind::OperatorOnly { op, name } => {
                return Err(format!("{name} uses the array operator {op}"));
            }
            LineKind::Key {
                op: None,
                name,
                value,
                ..
            } => {
                let Some(section) = &current else {
                    return Err(format!("{name} is set outside any section"));
                };
                if out.iter().any(|a| {
                    a.section.eq_ignore_ascii_case(section) && a.key.eq_ignore_ascii_case(&name)
                }) {
                    return Err(format!("[{section}] {name} is set more than once"));
                }
                out.push(Assignment {
                    section: section.clone(),
                    key: name,
                    value,
                });
            }
            LineKind::Other => {
                return Err(format!("the line \"{}\" is not a setting", line.trim()))
            }
        }
    }
    if out.is_empty() {
        return Err("the file sets nothing".to_string());
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Merged {
    pub text: String,
    pub changes: Vec<KeyChange>,
    pub created_sections: Vec<String>,
}

/// Merges scalar assignments into target text. A setting that already holds the value is left
/// alone and not owned. Any affected setting declared ambiguously in the target stops the
/// whole merge, so nothing partial is ever applied.
pub(crate) fn merge(target: &str, assignments: &[Assignment]) -> Result<Merged, String> {
    let mut doc = Doc::parse(target);
    let mut changes = Vec::new();
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut appended: Vec<(String, Vec<String>)> = Vec::new();
    let mut ambiguous = Vec::new();
    for a in assignments {
        match setting(&doc, &a.section, &a.key) {
            Setting::Ambiguous => ambiguous.push(format!("[{}] {}", a.section, a.key)),
            Setting::Value { value, .. } if value == a.value => {}
            Setting::Value { line, value } => {
                let LineKind::Key { eq, .. } = classify(&doc.lines[line]) else {
                    unreachable!("setting() returned a key line");
                };
                let original = doc.lines[line].clone();
                let after_eq = &original[eq + 1..];
                let pad = &after_eq[..after_eq.len() - after_eq.trim_start().len()];
                let unpadded = after_eq.trim_start();
                let trailing = &unpadded[unpadded.trim_end().len()..];
                doc.lines[line] = format!("{}{}{}{}", &original[..=eq], pad, a.value, trailing);
                changes.push(KeyChange {
                    section: a.section.clone(),
                    key: a.key.clone(),
                    before: Some(value),
                    applied: a.value.clone(),
                });
            }
            Setting::Absent {
                section_header: Some(header),
            } => {
                let body = doc.body(header);
                let at = body
                    .clone()
                    .rev()
                    .find(|&i| !matches!(classify(&doc.lines[i]), LineKind::Blank))
                    .map_or(header + 1, |i| i + 1);
                inserts.push((at, format!("{}={}", a.key, a.value)));
                changes.push(new_key(a));
            }
            Setting::Absent {
                section_header: None,
            } => {
                let line = format!("{}={}", a.key, a.value);
                match appended
                    .iter_mut()
                    .find(|(s, _)| s.eq_ignore_ascii_case(&a.section))
                {
                    Some((_, lines)) => lines.push(line),
                    None => appended.push((a.section.clone(), vec![line])),
                }
                changes.push(new_key(a));
            }
        }
    }
    if !ambiguous.is_empty() {
        return Err(format!(
            "your Engine.ini declares {} more than once or with array operators; apply this preset by hand in the Engine.ini editor",
            ambiguous.join(", ")
        ));
    }
    // Stable sort keeps several inserts at one position in assignment order.
    inserts.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let mut grouped: Vec<(usize, Vec<String>)> = Vec::new();
    for (at, line) in inserts {
        match grouped.last_mut() {
            Some((last, lines)) if *last == at => lines.push(line),
            _ => grouped.push((at, vec![line])),
        }
    }
    // Inserting in reverse at one index leaves the group in assignment order.
    for (at, lines) in grouped {
        for line in lines.into_iter().rev() {
            doc.lines.insert(at, line);
        }
    }
    let created_sections = appended.iter().map(|(s, _)| s.clone()).collect();
    for (section, lines) in appended {
        doc.lines.push(format!("[{section}]"));
        doc.lines.extend(lines);
    }
    Ok(Merged {
        text: doc.render(),
        changes,
        created_sections,
    })
}

fn new_key(a: &Assignment) -> KeyChange {
    KeyChange {
        section: a.section.clone(),
        key: a.key.clone(),
        before: None,
        applied: a.value.clone(),
    }
}

/// Restores owned settings that still hold exactly what the preset applied. A setting the
/// user or game changed since is left as it is and returned, and any owned setting that
/// became ambiguous refuses the whole restore, so nothing partial is ever applied.
pub(crate) fn restore(
    current: &str,
    changes: &[KeyChange],
    created_sections: &[String],
) -> Result<(String, Vec<KeyChange>), String> {
    let mut doc = Doc::parse(current);
    let ambiguous: Vec<String> = changes
        .iter()
        .filter(|c| matches!(setting(&doc, &c.section, &c.key), Setting::Ambiguous))
        .map(|c| format!("[{}] {}", c.section, c.key))
        .collect();
    if !ambiguous.is_empty() {
        return Err(format!(
            "your Engine.ini declares {} more than once or with array operators, so Modrex cannot tell which value the preset owns; review these settings in the Engine.ini editor before restoring",
            ambiguous.join(", ")
        ));
    }
    let mut kept = Vec::new();
    let mut removals = Vec::new();
    for c in changes {
        match (setting(&doc, &c.section, &c.key), &c.before) {
            (Setting::Value { line, value }, before) if value == c.applied => match before {
                Some(old) => {
                    let LineKind::Key { eq, .. } = classify(&doc.lines[line]) else {
                        unreachable!("setting() returned a key line");
                    };
                    let original = doc.lines[line].clone();
                    let after_eq = &original[eq + 1..];
                    let pad = &after_eq[..after_eq.len() - after_eq.trim_start().len()];
                    let unpadded = after_eq.trim_start();
                    let trailing = &unpadded[unpadded.trim_end().len()..];
                    doc.lines[line] = format!("{}{}{}{}", &original[..=eq], pad, old, trailing);
                }
                None => removals.push(line),
            },
            (Setting::Absent { .. }, None) => {}
            _ => kept.push(c.clone()),
        }
    }
    removals.sort_unstable_by(|a, b| b.cmp(a));
    for line in removals {
        doc.lines.remove(line);
    }
    for section in created_sections {
        let headers = doc.sections(section);
        let [header] = headers.as_slice() else {
            continue;
        };
        let body = doc.body(*header);
        if body
            .clone()
            .all(|i| matches!(classify(&doc.lines[i]), LineKind::Blank))
        {
            doc.lines.drain(*header..body.end);
        }
    }
    Ok((doc.render(), kept))
}

/// Owned settings whose declaration differs between two versions of a document.
pub(crate) fn owned_changes(old: &str, new: &str, changes: &[KeyChange]) -> Vec<KeyChange> {
    let (old_doc, new_doc) = (Doc::parse(old), Doc::parse(new));
    changes
        .iter()
        .filter(|c| {
            let strip = |s: Setting| match s {
                Setting::Value { value, .. } => Some(Some(value)),
                Setting::Absent { .. } => Some(None),
                Setting::Ambiguous => None,
            };
            strip(setting(&old_doc, &c.section, &c.key))
                != strip(setting(&new_doc, &c.section, &c.key))
        })
        .cloned()
        .collect()
}

/// Whether every owned setting still holds the value the preset applied.
pub(crate) fn preset_intact(text: &str, changes: &[KeyChange]) -> bool {
    let doc = Doc::parse(text);
    changes.iter().all(|c| {
        matches!(setting(&doc, &c.section, &c.key), Setting::Value { value, .. } if value == c.applied)
    })
}

#[cfg(test)]
#[path = "ini_tests.rs"]
mod tests;

use super::*;

#[test]
fn encoding_round_trips_keep_bom_and_line_endings() {
    for encoding in [
        Encoding::Ascii,
        Encoding::Utf8Bom,
        Encoding::Utf16LeBom,
        Encoding::Utf16BeBom,
    ] {
        for eol in [LineEnding::Lf, LineEnding::Crlf] {
            for text in ["; comment\n[S]\n+Paths=one\n+Paths=two\nA=\n", "[S]\nA=1"] {
                let bytes = encode(text, encoding, eol).unwrap();
                let decoded = decode(&bytes).unwrap();
                assert_eq!(decoded.text, text);
                assert_eq!(
                    encode(&decoded.text, decoded.encoding, decoded.eol).unwrap(),
                    bytes
                );
            }
        }
    }
    assert!(decode(b"[S]\nA=\0").is_err());
    assert!(decode("[S]\nA=é".as_bytes()).is_err());
    assert!(decode(&[0xff, 0xfe, 0x00]).is_err());
    let mixed = decode(b"[S]\r\nA=1\n").unwrap();
    assert_eq!(mixed.eol, LineEnding::Mixed);
    assert!(encode(&mixed.text, mixed.encoding, mixed.eol).is_err());
}

#[test]
fn preset_changes_restore_only_unchanged_owned_keys() {
    let target = "; personal\n[S]\n  A =  old  \nOther=9\n";
    let source = scalar_assignments("[S]\nA=new\nB=2\n").unwrap();
    let merged = merge(target, &source).unwrap();
    assert!(merged.text.contains("  A =  new  \nOther=9\n"));
    let (restored, kept) =
        restore(&merged.text, &merged.changes, &merged.created_sections).unwrap();
    assert_eq!(restored, target);
    assert!(kept.is_empty());
    let edited = merged
        .text
        .replace("B=2", "B=3")
        .replace("Other=9", "Other=10");
    let (restored, kept) = restore(&edited, &merged.changes, &merged.created_sections).unwrap();
    assert!(restored.contains("  A =  old  "));
    assert!(restored.contains("B=3"));
    assert!(restored.contains("Other=10"));
    assert_eq!(kept.len(), 1);
}

#[test]
fn equal_values_are_not_owned_and_ambiguous_declarations_are_refused() {
    let assignments = scalar_assignments("[S]\nA=1\n").unwrap();
    let merged = merge("[S]\nA=1", &assignments).unwrap();
    assert_eq!(merged.text, "[S]\nA=1");
    assert!(merged.changes.is_empty());
    for text in [
        "[S]\nA=1\na=1\n",
        "[S]\n+A=1\n",
        "[S]\nA=1\n[s]\nB=2\n",
        "A=1\n",
    ] {
        assert!(scalar_assignments(text).is_err(), "{text}");
    }
    assert!(merge("[S]\nA=old\nA=other\n", &assignments).is_err());
}

#[test]
fn appended_sections_keep_terminal_newline_and_external_comments() {
    let assignments = scalar_assignments("[New]\nA=1\n").unwrap();
    for target in ["", "; own", "; own\n"] {
        let merged = merge(target, &assignments).unwrap();
        let (restored, kept) =
            restore(&merged.text, &merged.changes, &merged.created_sections).unwrap();
        assert_eq!(restored, target);
        assert!(kept.is_empty());
        let commented = merged.text.replace("A=1", "A=1\n; user comment");
        let (restored, _) = restore(&commented, &merged.changes, &merged.created_sections).unwrap();
        assert!(restored.contains("[New]\n; user comment"));
    }
}

#[test]
fn restore_refuses_ambiguous_owned_settings_without_partial_result() {
    let target = "[S]\nA=old\nOther=9\n";
    let source = scalar_assignments("[S]\nA=new\nB=2\n").unwrap();
    let merged = merge(target, &source).unwrap();
    assert_eq!(merged.text, "[S]\nA=new\nOther=9\nB=2\n");
    // A still holds the applied value, so any partial restore would have rewritten it.
    for edited in [
        merged.text.replace("B=2", "B=2\nb=3"),
        merged.text.replace("B=2", "B=2\n+B=3"),
        merged.text.replace("B=2", "B=2\n!B"),
        merged.text.replace("B=2", ".B=2"),
    ] {
        let err = restore(&edited, &merged.changes, &merged.created_sections).unwrap_err();
        assert!(err.contains("[S] B"), "{err}");
        assert!(!err.contains("[S] A"), "{err}");
        assert!(err.contains("review"), "{err}");
    }
    let duplicated = format!("{}[s]\nC=1\n", merged.text);
    let err = restore(&duplicated, &merged.changes, &merged.created_sections).unwrap_err();
    assert!(err.contains("[S] A") && err.contains("[S] B"), "{err}");
}

#[test]
fn restore_ignores_ambiguity_outside_owned_settings() {
    let target = "[S]\nA=old\n+Paths=one\n+Paths=two\n[T]\nX=1\n[T]\nX=2\n";
    let source = scalar_assignments("[S]\nA=new\nB=2\n").unwrap();
    let merged = merge(target, &source).unwrap();
    let (restored, kept) =
        restore(&merged.text, &merged.changes, &merged.created_sections).unwrap();
    assert_eq!(restored, target);
    assert!(kept.is_empty());
    let edited = merged.text.replace("A=new", "A=user");
    let (restored, kept) = restore(&edited, &merged.changes, &merged.created_sections).unwrap();
    assert!(restored.contains("A=user"));
    assert!(!restored.contains("B=2"));
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].key, "A");
}

use super::*;

#[test]
fn parses_valid_link() {
    let link =
        parse_nxm_url("nxm://payday3/mods/12/files/34?key=abc123&expires=1700000000").unwrap();
    assert_eq!(
        link,
        NxmLink {
            game_id: "pd3".to_string(),
            mod_id: 12,
            file_id: 34,
            key: "abc123".to_string(),
            expires: "1700000000".to_string(),
        }
    );
}

#[test]
fn domain_match_is_case_insensitive() {
    let link =
        parse_nxm_url("nxm://PAYDAY3/mods/12/files/34?key=abc123&expires=1700000000").unwrap();
    assert_eq!(link.game_id, "pd3");
}

#[test]
fn rejects_wrong_scheme() {
    assert!(parse_nxm_url("https://payday3/mods/12/files/34?key=a&expires=1").is_err());
}

#[test]
fn rejects_unknown_domain() {
    assert!(parse_nxm_url("nxm://skyrimspecialedition/mods/1/files/1?key=a&expires=1").is_err());
}

#[test]
fn rejects_missing_key() {
    assert!(parse_nxm_url("nxm://payday3/mods/12/files/34?expires=1").is_err());
}

#[test]
fn rejects_wrong_path_shape() {
    assert!(parse_nxm_url("nxm://payday3/mods/12?key=a&expires=1").is_err());
}

#[test]
fn file_from_uri_reads_real_filename() {
    assert_eq!(
        file_from_uri("https://cdn.nexusmods.com/path/SomeMod-12-1-0.zip?token=x"),
        Some(("SomeMod-12-1-0.zip".to_string(), "zip".to_string()))
    );
}

#[test]
fn file_from_uri_none_when_no_extension() {
    assert_eq!(
        file_from_uri("https://cdn.nexusmods.com/path/SomeMod?token=x"),
        None
    );
}

/// A loose Engine.ini is reviewed under this name, and only a file named Engine.ini is
/// accepted as a preset, so the encoded CDN segment has to come back as the real name.
#[test]
fn file_from_uri_decodes_a_loose_resource_name() {
    assert_eq!(
        file_from_uri("https://cdn.nexusmods.com/1/2/Engine.ini?md5=x"),
        Some(("Engine.ini".to_string(), "ini".to_string()))
    );
    assert_eq!(
        file_from_uri("https://cdn.nexusmods.com/1/2/Intro%20Movie.BK2?md5=x"),
        Some(("Intro Movie.BK2".to_string(), "BK2".to_string()))
    );
}

#[test]
fn named_file_keeps_only_the_last_component() {
    assert_eq!(
        named_file("../config/Engine.ini"),
        Some(("Engine.ini".to_string(), "ini".to_string()))
    );
    assert_eq!(
        named_file("C:\\Config\\Engine.ini"),
        Some(("Engine.ini".to_string(), "ini".to_string()))
    );
    assert_eq!(named_file("NoExtension"), None);
}

use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

pub(super) fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    let path = shell_path(path);
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
pub(super) fn shell_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    // Shell and display paths must not replace canonical filesystem identities.
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let root = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = PathBuf::from(r"\\");
            root.push(server);
            root.push(share);
            root
        }
        _ => return path.to_path_buf(),
    };
    root.join(components.as_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_paths_keep_their_spelling() {
        for input in ["/home/user/Steam Library/game", "relative/catalog.manifest"] {
            assert_eq!(display_path(Path::new(input)), input);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_display_paths_preserve_drive_unc_and_unicode_names() {
        for (input, expected) in [
            (
                r"\\?\G:\SteamLibrary\steamapps\appmanifest_1144200.acf",
                r"G:\SteamLibrary\steamapps\appmanifest_1144200.acf",
            ),
            (
                r"\\?\UNC\server\share\Ігри\ゲーム\catalog.manifest",
                r"\\server\share\Ігри\ゲーム\catalog.manifest",
            ),
            (r"\\?\G:\", r"G:\"),
            (r"\\?\UNC\server\share\", r"\\server\share\"),
        ] {
            assert_eq!(display_path(Path::new(input)), expected);
            assert_eq!(shell_path(Path::new(input)), PathBuf::from(expected));
        }
        let long_path = format!(r"G:\{}catalog.manifest", "directory\\".repeat(50));
        assert_eq!(
            display_path(Path::new(&format!(r"\\?\{long_path}"))),
            long_path
        );
    }

    #[cfg(windows)]
    #[test]
    fn other_windows_namespaces_and_prefix_like_text_are_unchanged() {
        for input in [
            r"G:\SteamLibrary\catalog.manifest",
            r"\\server\share\catalog.manifest",
            r"\\?\Volume{guid}\catalog.manifest",
            r"\\.\PhysicalDrive0",
            r"notes\prefix-\\?\G:\catalog.manifest",
            r"\\?\G:catalog.manifest",
        ] {
            assert_eq!(shell_path(Path::new(input)), PathBuf::from(input));
            assert_eq!(display_path(Path::new(input)), input);
        }
    }

    #[cfg(windows)]
    #[test]
    fn shell_paths_preserve_unpaired_utf16() {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let mut input: Vec<u16> = r"\\?\G:\".encode_utf16().collect();
        input.extend([0xd800, u16::from(b'.'), u16::from(b'x')]);
        let path = PathBuf::from(OsString::from_wide(&input));
        assert_eq!(
            shell_path(&path)
                .as_os_str()
                .encode_wide()
                .collect::<Vec<_>>(),
            input[4..]
        );
    }
}

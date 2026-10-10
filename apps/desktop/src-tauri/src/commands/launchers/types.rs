pub struct SteamDef {
    pub app_id: u32,
    pub folder_name: &'static str,
}

pub struct EpicDef {
    pub display_name: &'static str,
}

pub struct XboxDef {
    pub product_id: &'static str,
    /// Relative to the install's Content folder, which is what a game path names for
    /// this store. A Microsoft Store build stages its binary under the project's
    /// WinGDK folder and ships no Win64 bootstrapper, so this is the only executable
    /// such an install has.
    pub executable: &'static str,
}

pub struct GameDef {
    pub name: &'static str,
    pub executables: &'static [&'static str],
    pub process_names: &'static [&'static str],
    pub steam: Option<SteamDef>,
    pub epic: Option<EpicDef>,
    pub xbox: Option<XboxDef>,
}

impl GameDef {
    /// Which executable to launch a copy in this folder with.
    pub fn resolve_executable(&self, game_path: &str) -> Option<&'static str> {
        self.executables
            .iter()
            .copied()
            .find(|exe| std::path::Path::new(game_path).join(exe).exists())
    }

    /// Whether this folder holds any of the game's builds. Deliberately wider than
    /// resolve_executable, which only knows the executables Modrex can spawn itself:
    /// a Microsoft Store build has no Win64 bootstrapper at its root, so recognising
    /// a folder by the launch executable alone rejects a real installation. Every
    /// check that asks "is the game here" belongs on this method, not that one.
    pub fn is_installation(&self, game_path: &str) -> bool {
        if self.resolve_executable(game_path).is_some() {
            return true;
        }
        let root = std::path::Path::new(game_path);
        self.xbox
            .as_ref()
            .is_some_and(|xbox| root.join(xbox.executable).exists())
    }
}

pub trait Launcher: Send + Sync {
    fn id(&self) -> &'static str;
    fn is_installed(&self) -> bool;
    fn find_game(&self, game: &GameDef) -> Option<String>;
    fn identify_path(&self, game_path: &str) -> bool;
    fn launch(&self, game: &GameDef, game_path: &str, opts: Option<&str>) -> Result<(), String>;
}

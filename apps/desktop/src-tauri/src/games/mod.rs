pub mod catalog;

use crate::game_package::GamePackage;
use std::sync::LazyLock;

#[cfg(test)]
mod package_tests;

include!(concat!(env!("OUT_DIR"), "/game_packages.rs"));

static PACKAGES: LazyLock<Vec<(&'static str, GamePackage)>> = LazyLock::new(built_in_packages);

pub fn discovered() -> &'static [(&'static str, GamePackage)] {
    &PACKAGES
}

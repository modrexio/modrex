pub mod package;

#[cfg(test)]
mod package_tests;

include!(concat!(env!("OUT_DIR"), "/game_packages.rs"));

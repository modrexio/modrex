//! Needs the network: cargo test --test export_preview_fixtures -- --ignored

#[test]
#[ignore]
fn export_preview_fixtures() {
    modrex_lib::export_preview_fixtures();
}

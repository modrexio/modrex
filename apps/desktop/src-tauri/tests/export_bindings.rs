#[test]
fn export_typescript_bindings() {
    // specta's type collection recurses deeply in unoptimized builds; the default test
    // thread stack overflows, so run the export on a roomier one.
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(modrex_lib::export_typescript_bindings)
        .expect("failed to spawn export thread")
        .join()
        .expect("export thread panicked");
}

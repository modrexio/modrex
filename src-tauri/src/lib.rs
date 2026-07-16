mod commands;

#[cfg(windows)]
mod windows_fullscreen;

use tauri::{webview::PageLoadEvent, Manager};

pub fn run() {
    std::panic::set_hook(Box::new(|panic_info| {
        log::error!("PANIC: {panic_info}");
    }));

    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    #[cfg(target_os = "linux")]
    // WebKit's DMA-BUF renderer breaks under XWayland and some Wayland compositors
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let (discord_state, discord_rx) = commands::discord::DiscordState::new(true);

    let app = tauri::Builder::default()
        .manage(commands::updater::UpdaterState::new())
        .manage(commands::startup::StartupState::default())
        .manage(discord_state)
        .register_uri_scheme_protocol("thumb", |ctx, request| {
            commands::thumbnails::handle_thumb_protocol(ctx.app_handle(), request)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn)
                .level_for("modrex_lib", log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .setup(|app| {
            log::info!("Modrex started");
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(windows)]
                windows_fullscreen::install(&window)?;
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() != "splash" || payload.event() != PageLoadEvent::Finished {
                return;
            }
            if webview.state::<commands::startup::StartupState>().is_ready() {
                return;
            }
            if let Err(error) = webview.window().show() {
                log::error!("failed to show loaded startup window: {error}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            // startup
            commands::startup::report_startup_phase,
            commands::startup::get_startup_phase,
            commands::startup::finish_startup,
            // api
            commands::api::list_mods,
            commands::api::get_mod,
            commands::api::list_mod_files,
            commands::api::list_mod_links,
            commands::api::list_categories,
            commands::api::list_tags,
            // discord
            commands::discord::set_discord_presence_enabled,
            commands::discord::update_discord_presence,
            // settings
            commands::settings::get_settings,
            commands::settings::get_game_settings,
            commands::settings::set_launcher,
            commands::settings::set_launch_options,
            commands::settings::set_crimeboss_install_mode,
            commands::settings::set_suppress_crash_reporter,
            commands::settings::set_skip_fileopenlog_warning,
            commands::settings::dismiss_deps_warning,
            commands::settings::record_successful_install,
            commands::settings::get_analytics_consent,
            commands::settings::set_analytics_consent,
            commands::analytics::track_event,
            // mods
            commands::mods::get_installed,
            commands::mods::install_mod,
            commands::mods::install_file,
            commands::mods::install_dropped_file,
            commands::mods::install_from_zip_entry,
            commands::mods::install_cb_flat_archive,
            commands::mods::install_host_pack,
            commands::mods::delete_temp_file,
            commands::mods::uninstall_mod,
            commands::mods::enable_mod,
            commands::mods::disable_mod,
            commands::mods::move_crimeboss_mod_target,
            commands::mods::reorder_in_folder,
            commands::mods::move_to_folder,
            commands::mods::reorder_children,
            commands::mods::move_folder,
            commands::mods::create_folder,
            commands::mods::rename_folder,
            commands::mods::delete_folder,
            commands::mods::open_mods_folder,
            commands::mods::list_mod_folders,
            commands::mods::open_mod_folder,
            // superblt / pdth_overrides / dahm
            commands::superblt::check_superblt,
            commands::superblt::install_superblt,
            commands::superblt::is_pd2_diesel3,
            commands::pdth_overrides::check_pdth_overrides,
            commands::pdth_overrides::install_pdth_overrides,
            commands::dahm::check_dahm,
            commands::dahm::install_dahm,
            commands::raid_superblt::check_raid_superblt,
            commands::raid_superblt::install_raid_superblt,
            commands::ue4ss::check_ue4ss,
            // launchers & system
            commands::launchers::installed_launchers,
            commands::launchers::configure_game_path,
            commands::launchers::pick_folder,
            commands::launchers::launch_game,
            commands::launchers::launch_without_mods,
            commands::launchers::restore_mods,
            commands::launchers::is_game_running,
            commands::launchers::stop_game,
            commands::launchers::shell_open_external,
            commands::launchers::shell_open_path,
            commands::launchers::open_log_file,
            commands::launchers::open_data_folder,
            commands::launchers::open_app_folder,
            // updater
            commands::updater::check_for_update,
            commands::updater::download_update,
            commands::updater::install_update,
            // thumbnails
            commands::thumbnails::get_thumbnail,
            // mod index
            commands::mod_index::get_index_mod_files,
            // news
            commands::news::fetch_news,
            commands::news::refresh_news,
            commands::news::fetch_news_page,
            // storage / data management
            commands::storage::get_storage_usage,
            commands::storage::clear_thumbnail_cache,
            commands::storage::clear_index_cache,
            commands::storage::clear_news_cache,
            commands::settings::reset_app_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    commands::settings::migrate_from_old_identifier(app.handle());
    commands::settings::migrate_from_electron(app.handle());

    let games_configured = commands::settings::read_settings(app.handle())
        .games
        .as_ref()
        .map(|g| g.values().filter(|gs| gs.game_path.is_some()).count())
        .unwrap_or(0);
    commands::analytics::track(
        app.handle(),
        "app_started",
        serde_json::json!({ "games_configured": games_configured }),
    );

    {
        let discord_enabled = commands::settings::read_settings(app.handle())
            .discord_rich_presence_enabled
            .unwrap_or(true);
        let discord_state = app.state::<commands::discord::DiscordState>();
        discord_state
            .enabled
            .store(discord_enabled, std::sync::atomic::Ordering::Relaxed);
        commands::discord::start(std::sync::Arc::clone(&discord_state.enabled), discord_rx);
    }

    let handle = app.handle().clone();
    tauri::async_runtime::spawn(commands::mod_index::ensure_index(handle));

    let handle = app.handle().clone();
    tauri::async_runtime::spawn(commands::thumbnails::cleanup_thumbnail_cache(handle));

    #[cfg(not(debug_assertions))]
    {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = commands::updater::check_for_update(handle).await;
        });
    }

    app.run(|_, _| {});
}

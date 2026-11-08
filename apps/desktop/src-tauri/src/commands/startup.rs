use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum StartupPhase {
    #[default]
    Prepare,
    Updating,
    Interface,
    Game,
    Mods,
    Ready,
    Error,
}

/// Shown once after Modrex opens on the version an update on open installed.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedNotice {
    pub version: String,
    pub release_url: String,
}

/// Whether the renderer is held back while a nightly build may install an update on open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hold {
    Holding,
    Installing,
    Released,
}

/// The phase and the hold change together under one lock, so a release can never
/// interleave with the installer handoff or with a phase report.
#[derive(Debug)]
struct Startup {
    phase: StartupPhase,
    hold: Hold,
}

impl Startup {
    fn new(holding: bool) -> Self {
        Self {
            phase: StartupPhase::Prepare,
            hold: if holding {
                Hold::Holding
            } else {
                Hold::Released
            },
        }
    }

    /// One way: once released, this process never installs on open. Returns false only
    /// when the installer handoff already won.
    fn release(&mut self) -> bool {
        match self.hold {
            Hold::Installing => false,
            Hold::Released => true,
            Hold::Holding => {
                self.hold = Hold::Released;
                if self.phase == StartupPhase::Updating {
                    self.phase = StartupPhase::Prepare;
                }
                true
            }
        }
    }

    fn begin_install(&mut self) -> bool {
        if self.hold != Hold::Holding {
            return false;
        }
        self.hold = Hold::Installing;
        true
    }

    /// The installer did not take over, so the open continues as if released.
    fn end_install(&mut self) {
        self.hold = Hold::Released;
        if self.phase == StartupPhase::Updating {
            self.phase = StartupPhase::Prepare;
        }
    }

    fn set_updating(&mut self) -> bool {
        if self.hold != Hold::Holding {
            return false;
        }
        self.phase = StartupPhase::Updating;
        true
    }

    /// The watchdog surfaces the recovery button unless startup finished or the installer
    /// is taking over. Returns whether the phase became error.
    fn expire(&mut self) -> bool {
        if self.hold == Hold::Installing || self.phase == StartupPhase::Ready {
            return false;
        }
        self.release();
        self.phase = StartupPhase::Error;
        true
    }
}

pub struct StartupState {
    startup: Mutex<Startup>,
    holding_build: bool,
    // A watch rather than a notify, so a gate request made after the release, such as a
    // reloaded webview, resolves at once instead of waiting forever.
    released: watch::Sender<bool>,
    notice: Mutex<Option<UpdatedNotice>>,
    // Neither release nor ready says main is on screen: the renderer mounts after the
    // release, and the recovery button shows main without ready.
    presented: AtomicBool,
}

impl StartupState {
    /// A build that may install on open starts holding, every other build starts released.
    pub fn new(holding: bool) -> Self {
        Self {
            startup: Mutex::new(Startup::new(holding)),
            holding_build: holding,
            released: watch::Sender::new(!holding),
            notice: Mutex::new(None),
            presented: AtomicBool::new(false),
        }
    }

    /// Whether finish_startup has shown main. Until then the splash is the only window on screen.
    pub fn presented(&self) -> bool {
        self.presented.load(Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Startup> {
        self.startup.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_ready(&self) -> bool {
        self.lock().phase == StartupPhase::Ready
    }

    pub fn holding_build(&self) -> bool {
        self.holding_build
    }

    pub fn holding(&self) -> bool {
        self.lock().hold == Hold::Holding
    }

    /// Lets the renderer start and revokes installing on open for the rest of this process.
    /// It never shows a window: the splash stays until the renderer reports ready.
    pub fn release(&self, app: &AppHandle) {
        let mut startup = self.lock();
        let before = startup.phase;
        if !startup.release() {
            return;
        }
        let after = startup.phase;
        drop(startup);
        if before != after {
            emit_phase(app, after);
        }
        self.released.send_replace(true);
    }

    /// Claims the installer handoff. False means a release won and nothing may install.
    pub fn begin_install(&self) -> bool {
        self.lock().begin_install()
    }

    pub fn end_install(&self, app: &AppHandle) {
        let mut startup = self.lock();
        startup.end_install();
        let phase = startup.phase;
        drop(startup);
        emit_phase(app, phase);
        self.released.send_replace(true);
    }

    pub fn set_updating(&self, app: &AppHandle) -> bool {
        if !self.lock().set_updating() {
            return false;
        }
        emit_phase(app, StartupPhase::Updating);
        true
    }

    pub fn expire(&self, app: &AppHandle) {
        if !self.lock().expire() {
            return;
        }
        emit_phase(app, StartupPhase::Error);
        self.released.send_replace(true);
    }

    /// Watches the hold. The value turns true once on release and stays true.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.released.subscribe()
    }

    pub fn set_notice(&self, notice: UpdatedNotice) {
        *self.notice.lock().unwrap_or_else(|e| e.into_inner()) = Some(notice);
    }

    fn take_notice(&self) -> Option<UpdatedNotice> {
        self.notice.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

fn emit_phase(app: &AppHandle, phase: StartupPhase) {
    if let Err(e) = app.emit_to("splash", "startup:progress", phase) {
        log::warn!("failed to report startup progress: {e}");
    }
}

#[tauri::command]
#[specta::specta]
pub fn report_startup_phase(
    app: AppHandle,
    state: State<'_, StartupState>,
    phase: StartupPhase,
) -> Result<(), String> {
    // A report proves the renderer is running, so it revokes installing on open.
    state.release(&app);
    let mut startup = state.lock();
    let first_ready = phase == StartupPhase::Ready && startup.phase != StartupPhase::Ready;
    startup.phase = phase;
    drop(startup);
    if first_ready && state.holding_build() {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || super::on_open_update::reached_ready(&handle));
    }
    app.emit_to("splash", "startup:progress", phase)
        .map_err(|e| format!("failed to report startup progress: {e}"))
}

#[tauri::command]
#[specta::specta]
pub fn get_startup_phase(state: State<'_, StartupState>) -> StartupPhase {
    state.lock().phase
}

/// Resolves once the renderer may start, with the notice for an update that just applied.
#[tauri::command]
#[specta::specta]
pub async fn wait_for_startup_gate(app: AppHandle) -> Result<Option<UpdatedNotice>, String> {
    let state = app.state::<StartupState>();
    state
        .subscribe()
        .wait_for(|open| *open)
        .await
        .map_err(|_| "the startup gate closed without opening".to_string())?;
    Ok(state.take_notice())
}

/// Backs the splash's skip button while an update on open downloads.
#[tauri::command]
#[specta::specta]
pub fn skip_startup_update(app: AppHandle, state: State<'_, StartupState>) {
    state.release(&app);
}

#[tauri::command]
#[specta::specta]
pub fn finish_startup(app: AppHandle, state: State<'_, StartupState>) -> Result<(), String> {
    // The recovery button reaches this before ready too, and must revoke an install first.
    state.release(&app);
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    main.show()
        .map_err(|e| format!("failed to show main window: {e}"))?;
    // Set before the splash closes, because that close goes through the splash close guard.
    state.presented.store(true, Ordering::SeqCst);
    main.set_focus()
        .map_err(|e| format!("failed to focus main window: {e}"))?;

    let splash = app
        .get_webview_window("splash")
        .ok_or_else(|| "startup window is unavailable".to_string())?;
    splash
        .close()
        .map_err(|e| format!("failed to close startup window: {e}"))
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;

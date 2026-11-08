use super::*;

#[test]
fn a_build_that_does_not_hold_starts_released() {
    let mut startup = Startup::new(false);
    assert_eq!(startup.hold, Hold::Released);
    assert!(!startup.begin_install());
    assert!(!startup.set_updating());
}

#[test]
fn release_is_one_way() {
    let mut startup = Startup::new(true);
    assert!(startup.release());
    assert!(startup.release());
    assert!(!startup.begin_install());
    assert_eq!(startup.hold, Hold::Released);
}

#[test]
fn release_loses_to_an_installer_handoff_that_already_won() {
    let mut startup = Startup::new(true);
    assert!(startup.begin_install());
    assert!(!startup.release());
    assert_eq!(startup.hold, Hold::Installing);
}

#[test]
fn a_failed_handoff_releases_and_leaves_the_updating_phase() {
    let mut startup = Startup::new(true);
    assert!(startup.set_updating());
    assert!(startup.begin_install());
    startup.end_install();
    assert_eq!(startup.hold, Hold::Released);
    assert_eq!(startup.phase, StartupPhase::Prepare);
}

#[test]
fn release_replaces_updating_with_prepare() {
    let mut startup = Startup::new(true);
    assert!(startup.set_updating());
    assert_eq!(startup.phase, StartupPhase::Updating);
    startup.release();
    assert_eq!(startup.phase, StartupPhase::Prepare);
}

#[test]
fn updating_is_shown_only_while_holding() {
    let mut startup = Startup::new(true);
    startup.release();
    assert!(!startup.set_updating());
    assert_eq!(startup.phase, StartupPhase::Prepare);
}

#[test]
fn the_watchdog_never_replaces_ready() {
    let mut startup = Startup::new(true);
    startup.release();
    startup.phase = StartupPhase::Ready;
    assert!(!startup.expire());
    assert_eq!(startup.phase, StartupPhase::Ready);
}

#[test]
fn the_watchdog_leaves_an_installer_handoff_alone() {
    let mut startup = Startup::new(true);
    assert!(startup.begin_install());
    assert!(!startup.expire());
    assert_eq!(startup.hold, Hold::Installing);
}

#[test]
fn the_watchdog_releases_and_shows_the_recovery_state() {
    let mut startup = Startup::new(true);
    assert!(startup.expire());
    assert_eq!(startup.hold, Hold::Released);
    assert_eq!(startup.phase, StartupPhase::Error);
}

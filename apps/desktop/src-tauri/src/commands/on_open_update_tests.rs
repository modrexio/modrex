use super::*;

const RUNNING: &str = "0.17.0-nightly.20261107.1";
const NEWER: &str = "0.17.0-nightly.20261108.1";

fn facts(state: Option<&UpdateState>) -> OpenFacts<'_> {
    OpenFacts {
        running: RUNNING,
        channel: UpdateChannel::Nightly,
        bundle: Some(BundleType::Nsis),
        launched_by_link: false,
        state,
    }
}

fn record(from: &str, to: &str, attempts: u32) -> InstallRecord {
    InstallRecord {
        from: from.into(),
        to: to.into(),
        attempts,
    }
}

#[test]
fn a_clean_nightly_open_runs_the_step() {
    let state = UpdateState::default();
    assert_eq!(plan_open(&facts(Some(&state))), OpenAction::RunStep);
    let appimage = OpenFacts {
        bundle: Some(BundleType::AppImage),
        ..facts(Some(&state))
    };
    assert_eq!(plan_open(&appimage), OpenAction::RunStep);
}

#[test]
fn a_stable_build_never_runs_the_step_even_on_the_nightly_channel() {
    let state = UpdateState::default();
    let stable = OpenFacts {
        running: "0.17.0",
        ..facts(Some(&state))
    };
    assert_eq!(plan_open(&stable), OpenAction::KeepPopup);
}

#[test]
fn a_nightly_build_set_to_stable_keeps_the_popup() {
    let state = UpdateState::default();
    let on_stable = OpenFacts {
        channel: UpdateChannel::Stable,
        ..facts(Some(&state))
    };
    assert_eq!(plan_open(&on_stable), OpenAction::KeepPopup);
}

#[test]
fn deb_rpm_msi_and_unbundled_builds_keep_the_popup() {
    let state = UpdateState::default();
    for bundle in [
        Some(BundleType::Deb),
        Some(BundleType::Rpm),
        Some(BundleType::Msi),
        None,
    ] {
        let other = OpenFacts {
            bundle: bundle.clone(),
            ..facts(Some(&state))
        };
        assert_eq!(plan_open(&other), OpenAction::KeepPopup, "{bundle:?}");
    }
}

#[test]
fn a_launch_link_skips_the_update_for_that_open() {
    let state = UpdateState::default();
    let linked = OpenFacts {
        launched_by_link: true,
        ..facts(Some(&state))
    };
    assert_eq!(plan_open(&linked), OpenAction::KeepPopup);
}

#[test]
fn an_open_that_died_inside_the_step_makes_the_next_skip_it_once() {
    let state = UpdateState {
        step_started: true,
        ..UpdateState::default()
    };
    assert_eq!(plan_open(&facts(Some(&state))), OpenAction::SkipOnce);
    let next = state_at_open(&state, OpenAction::SkipOnce, RUNNING);
    assert!(!next.step_started);
    assert_eq!(plan_open(&facts(Some(&next))), OpenAction::RunStep);
}

#[test]
fn an_unreadable_state_skips_once_and_is_rewritten_clean() {
    assert_eq!(plan_open(&facts(None)), OpenAction::SkipOnce);
    let next = state_at_open(&UpdateState::default(), OpenAction::SkipOnce, RUNNING);
    assert_eq!(
        next,
        UpdateState {
            step_started: false,
            failed_starts: 1,
            record: None,
        }
    );
}

#[test]
fn arriving_at_the_target_is_reported_before_any_other_rule_and_retires_the_record() {
    let state = UpdateState {
        step_started: true,
        failed_starts: 0,
        record: Some(record("0.17.0-nightly.20261106.1", RUNNING, 1)),
    };
    let linked_on_deb = OpenFacts {
        bundle: Some(BundleType::Deb),
        launched_by_link: true,
        channel: UpdateChannel::Stable,
        ..facts(Some(&state))
    };
    assert_eq!(plan_open(&linked_on_deb), OpenAction::Updated);
    let next = state_at_open(&state, OpenAction::Updated, RUNNING);
    assert_eq!(next.record, None);
    assert!(!next.step_started);
}

#[test]
fn only_the_step_sets_the_mark() {
    let state = UpdateState::default();
    assert!(state_at_open(&state, OpenAction::RunStep, RUNNING).step_started);
    assert!(!state_at_open(&state, OpenAction::KeepPopup, RUNNING).step_started);
}

#[test]
fn an_attempt_from_another_version_is_dropped_at_open() {
    let state = UpdateState {
        record: Some(record("0.16.0-nightly.20261101.1", NEWER, 1)),
        ..UpdateState::default()
    };
    assert_eq!(
        state_at_open(&state, OpenAction::RunStep, RUNNING).record,
        None
    );
    let live = UpdateState {
        record: Some(record(RUNNING, NEWER, 1)),
        ..UpdateState::default()
    };
    assert_eq!(
        state_at_open(&live, OpenAction::RunStep, RUNNING).record,
        live.record
    );
}

#[test]
fn every_open_counts_as_a_start_until_ready() {
    let mut state = UpdateState::default();
    for _ in 0..FAILED_STARTS_BEFORE_DIALOG {
        assert!(!warn_failed_starts(&state));
        state = state_at_open(&state, OpenAction::RunStep, RUNNING);
    }
    assert_eq!(state.failed_starts, FAILED_STARTS_BEFORE_DIALOG);
    assert!(warn_failed_starts(&state));
}

#[test]
fn the_installer_exit_is_not_a_failed_start() {
    let opened = state_at_open(&UpdateState::default(), OpenAction::RunStep, RUNNING);
    let installing = state_for_install(&opened, RUNNING, NEWER);
    assert_eq!(installing.failed_starts, 0);
    assert!(!installing.step_started);
    assert_eq!(installing.record, Some(record(RUNNING, NEWER, 1)));
}

#[test]
fn two_failed_attempts_at_one_version_leave_it_to_the_popup() {
    let first = state_for_install(&UpdateState::default(), RUNNING, NEWER);
    assert_eq!(
        plan_found(NEWER, first.record.as_ref(), false),
        FoundAction::Download
    );
    let second = state_for_install(&first, RUNNING, NEWER);
    assert_eq!(second.record, Some(record(RUNNING, NEWER, 2)));
    assert_eq!(
        plan_found(NEWER, second.record.as_ref(), true),
        FoundAction::Popup
    );
}

#[test]
fn a_newer_target_starts_counting_again() {
    let failed = UpdateState {
        record: Some(record(RUNNING, NEWER, 2)),
        ..UpdateState::default()
    };
    let newest = "0.17.0-nightly.20261109.1";
    assert_eq!(
        plan_found(newest, failed.record.as_ref(), false),
        FoundAction::Download
    );
    let next = state_for_install(&failed, RUNNING, newest);
    assert_eq!(next.record, Some(record(RUNNING, newest, 1)));
}

#[test]
fn a_saved_package_for_the_offered_version_installs_without_a_download() {
    assert_eq!(plan_found(NEWER, None, true), FoundAction::InstallSaved);
    assert_eq!(plan_found(NEWER, None, false), FoundAction::Download);
}

#[test]
fn a_signature_failure_stops_installing_that_version_on_open() {
    let state = UpdateState {
        failed_starts: 1,
        ..UpdateState::default()
    };
    let rejected = state_for_rejected(&state, RUNNING, NEWER);
    assert_eq!(rejected.failed_starts, 1);
    assert_eq!(
        plan_found(NEWER, rejected.record.as_ref(), true),
        FoundAction::Popup
    );
}

#[test]
fn signature_errors_are_told_apart_from_network_errors() {
    use tauri_plugin_updater::Error;
    assert!(is_signature_error(&Error::MissingSignedVersion));
    assert!(is_signature_error(&Error::SignedVersionMismatch {
        signed: RUNNING.into(),
        announced: NEWER.into(),
    }));
    assert!(!is_signature_error(&Error::ReleaseNotFound));
    assert!(!is_signature_error(&Error::Network("timed out".into())));
}

#[test]
fn the_state_file_round_trips_and_reads_missing_fields_as_defaults() {
    let state = UpdateState {
        step_started: true,
        failed_starts: 2,
        record: Some(record(RUNNING, NEWER, 1)),
    };
    let json = serde_json::to_string(&state).unwrap();
    assert_eq!(serde_json::from_str::<UpdateState>(&json).unwrap(), state);
    assert_eq!(
        serde_json::from_str::<UpdateState>("{}").unwrap(),
        UpdateState::default()
    );
    assert!(serde_json::from_str::<UpdateState>(r#"{"failedStarts":null}"#).is_err());
}

#[test]
fn the_state_file_reads_missing_as_default_and_garbage_as_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-state.json");
    assert_eq!(read_state(&path).unwrap(), UpdateState::default());
    std::fs::write(&path, "{ not json").unwrap();
    assert!(read_state(&path).is_err());
    let state = UpdateState {
        failed_starts: 3,
        ..UpdateState::default()
    };
    write_state(&path, &state).unwrap();
    assert_eq!(read_state(&path).unwrap(), state);
}

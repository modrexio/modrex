use super::{commit_install, StateLocks};
use std::sync::Arc;

#[tokio::test]
async fn cancelled_install_caller_keeps_game_locked_until_worker_finishes() {
    let locks = Arc::new(StateLocks::default());
    let guard = locks.acquire("pd3").await;
    let game_lock = {
        let locks = locks.0.lock().unwrap();
        locks.get("pd3").unwrap().clone()
    };
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let (committed_tx, committed_rx) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(commit_install(guard, move || {
        started_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
        committed_tx.send(()).unwrap();
        Ok(())
    }));
    started_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());

    assert!(game_lock.try_lock().is_err());
    let other_game = locks.acquire("pd2").await;
    finish_tx.send(()).unwrap();
    committed_rx.await.unwrap();
    let next = locks.acquire("pd3").await;
    drop(next);
    drop(other_game);
}

#[tokio::test]
async fn install_commits_read_state_after_the_previous_commit_writes_it() {
    let locks = Arc::new(StateLocks::default());
    let state = Arc::new(std::sync::Mutex::new(Vec::new()));
    let first_guard = locks.acquire("pd3").await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let first_state = state.clone();
    let first = tokio::spawn(commit_install(first_guard, move || {
        let mut snapshot = first_state.lock().unwrap().clone();
        started_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
        snapshot.push("first");
        *first_state.lock().unwrap() = snapshot;
        Ok(())
    }));
    started_rx.await.unwrap();
    let second_locks = locks.clone();
    let second_state = state.clone();
    let second = tokio::spawn(async move {
        let guard = second_locks.acquire("pd3").await;
        commit_install(guard, move || {
            let mut snapshot = second_state.lock().unwrap().clone();
            snapshot.push("second");
            *second_state.lock().unwrap() = snapshot;
            Ok(())
        })
        .await
    });
    finish_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(*state.lock().unwrap(), vec!["first", "second"]);
}

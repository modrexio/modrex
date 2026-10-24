use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::AsyncWrite;

async fn response(bytes: Vec<u8>) -> (reqwest::Response, std::thread::JoinHandle<()>) {
    rustls::crypto::ring::default_provider()
        .install_default()
        .unwrap_or_else(|_| assert!(rustls::crypto::CryptoProvider::get_default().is_some()));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let read = socket.read(&mut buffer).unwrap();
            assert_ne!(read, 0);
            request.extend_from_slice(&buffer[..read]);
        }
        socket.write_all(&bytes).unwrap();
    });
    let response = crate::commands::api::http_client()
        .get(format!("http://{address}/mod"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    (response, server)
}

fn known_length_response(body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[derive(Default)]
struct RecordingWriter {
    bytes: Vec<u8>,
    flushed: Arc<AtomicBool>,
    fail_write: bool,
    fail_flush: bool,
}

impl AsyncWrite for RecordingWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.fail_write {
            return Poll::Ready(Err(std::io::Error::other("disk write failed")));
        }
        self.bytes.extend_from_slice(bytes);
        Poll::Ready(Ok(bytes.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if self.fail_flush {
            return Poll::Ready(Err(std::io::Error::other("disk flush failed")));
        }
        self.flushed.store(true, Ordering::SeqCst);
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.poll_flush(cx)
    }
}

#[test]
fn progress_updates_follow_elapsed_time_without_catching_up() {
    let start = Instant::now();
    let mut last_update = start;
    let updates: Vec<_> = (0..=1050)
        .filter(|millis| {
            take_progress_update(&mut last_update, start + Duration::from_millis(*millis))
        })
        .collect();
    assert_eq!(updates, (100..=1000).step_by(100).collect::<Vec<_>>());
    assert!(take_progress_update(
        &mut last_update,
        start + Duration::from_secs(5)
    ));
    assert!(!take_progress_update(
        &mut last_update,
        start + Duration::from_secs(5)
    ));
    assert!(!take_progress_update(
        &mut last_update,
        start + Duration::from_millis(5099)
    ));
    assert!(take_progress_update(
        &mut last_update,
        start + Duration::from_millis(5100)
    ));
    let mut second_download = start;
    assert!(take_progress_update(
        &mut second_download,
        start + Duration::from_millis(100)
    ));
}

#[tokio::test]
async fn known_length_download_reports_exact_endpoints_after_flush() {
    let body: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
    let (response, server) = response(known_length_response(&body)).await;
    let mut writer = RecordingWriter::default();
    let flushed = writer.flushed.clone();
    let mut progress = Vec::new();
    write_download(response, &mut writer, |downloaded, total| {
        progress.push((downloaded, total, flushed.load(Ordering::SeqCst)));
    })
    .await
    .unwrap();
    server.join().unwrap();
    assert_eq!(writer.bytes, body);
    assert_eq!(progress.first(), Some(&(0, body.len() as u64, false)));
    assert_eq!(
        progress.last(),
        Some(&(body.len() as u64, body.len() as u64, true))
    );
    assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));
}

#[tokio::test]
async fn chunked_download_keeps_total_unknown_and_flushes_final_bytes() {
    let (response, server) = response(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n".to_vec(),
    )
    .await;
    let mut writer = RecordingWriter::default();
    let mut progress = Vec::new();
    write_download(response, &mut writer, |downloaded, total| {
        progress.push((downloaded, total));
    })
    .await
    .unwrap();
    server.join().unwrap();
    assert_eq!(writer.bytes, b"abcde");
    assert_eq!(progress.first(), Some(&(0, 0)));
    assert_eq!(progress.last(), Some(&(5, 0)));
    assert!(progress.iter().all(|(_, total)| *total == 0));
}

#[tokio::test]
async fn empty_download_still_reports_initial_and_flushed_final_progress() {
    let (response, server) = response(known_length_response(b"")).await;
    let mut writer = RecordingWriter::default();
    let flushed = writer.flushed.clone();
    let mut progress = Vec::new();
    write_download(response, &mut writer, |downloaded, total| {
        progress.push((downloaded, total, flushed.load(Ordering::SeqCst)));
    })
    .await
    .unwrap();
    server.join().unwrap();
    assert_eq!(progress, [(0, 0, false), (0, 0, true)]);
}

#[tokio::test]
async fn truncated_download_does_not_flush_or_report_success() {
    let (response, server) = response(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
    )
    .await;
    let mut writer = RecordingWriter::default();
    let flushed = writer.flushed.clone();
    let mut snapshots_after_flush = 0;
    assert!(write_download(response, &mut writer, |_, _| {
        snapshots_after_flush += usize::from(flushed.load(Ordering::SeqCst));
    })
    .await
    .is_err());
    server.join().unwrap();
    assert!(!writer.flushed.load(Ordering::SeqCst));
    assert_eq!(snapshots_after_flush, 0);
}

#[tokio::test]
async fn write_and_flush_errors_propagate_without_terminal_progress() {
    for fail_write in [true, false] {
        let (response, server) = response(known_length_response(b"mod bytes")).await;
        let mut writer = RecordingWriter {
            fail_write,
            fail_flush: !fail_write,
            ..Default::default()
        };
        let flushed = writer.flushed.clone();
        let mut snapshots_after_flush = 0;
        let error = write_download(response, &mut writer, |_, _| {
            snapshots_after_flush += usize::from(flushed.load(Ordering::SeqCst));
        })
        .await
        .unwrap_err();
        server.join().unwrap();
        assert!(error.contains(if fail_write {
            "disk write failed"
        } else {
            "disk flush failed"
        }));
        assert_eq!(snapshots_after_flush, 0);
    }
}

#[tokio::test]
async fn downloaded_file_is_complete_when_streaming_returns() {
    let body = vec![0x5a; 128 * 1024];
    let (response, server) = response(known_length_response(&body)).await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mod.pak");
    let mut file = tokio::fs::File::create(&path).await.unwrap();
    write_download(response, &mut file, |_, _| {})
        .await
        .unwrap();
    server.join().unwrap();
    drop(file);
    assert_eq!(std::fs::read(&path).unwrap(), body);
}

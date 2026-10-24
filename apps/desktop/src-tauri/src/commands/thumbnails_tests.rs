use super::{cleanup_dir, is_safe_thumb_filename, sanitize_thumb_filename, thumb_content_type};
use filetime::FileTime;
use std::time::{Duration, SystemTime};
use tempfile::tempdir;

fn set_mtime_days_ago(path: &std::path::Path, days: u64) {
    let t = SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60);
    filetime::set_file_mtime(path, FileTime::from_system_time(t)).unwrap();
}

#[test]
fn removes_files_older_than_max_age() {
    let dir = tempdir().unwrap();
    let old = dir.path().join("old.webp");
    std::fs::write(&old, b"x").unwrap();
    set_mtime_days_ago(&old, 91);

    cleanup_dir(dir.path(), Duration::from_secs(90 * 24 * 60 * 60));

    assert!(!old.exists());
}

#[test]
fn keeps_files_within_max_age() {
    let dir = tempdir().unwrap();
    let fresh = dir.path().join("fresh.webp");
    std::fs::write(&fresh, b"x").unwrap();
    set_mtime_days_ago(&fresh, 89);

    cleanup_dir(dir.path(), Duration::from_secs(90 * 24 * 60 * 60));

    assert!(fresh.exists());
}

#[test]
fn mixed_keeps_fresh_removes_old() {
    let dir = tempdir().unwrap();
    let old = dir.path().join("old.webp");
    let fresh = dir.path().join("fresh.webp");
    std::fs::write(&old, b"x").unwrap();
    std::fs::write(&fresh, b"x").unwrap();
    set_mtime_days_ago(&old, 91);
    set_mtime_days_ago(&fresh, 10);

    cleanup_dir(dir.path(), Duration::from_secs(90 * 24 * 60 * 60));

    assert!(!old.exists());
    assert!(fresh.exists());
}

#[test]
fn missing_dir_does_not_panic() {
    cleanup_dir(
        std::path::Path::new("/nonexistent/thumbnails"),
        Duration::from_secs(1),
    );
}

#[test]
fn sanitize_accepts_plain_filenames() {
    assert_eq!(
        sanitize_thumb_filename("/abc123.webp"),
        Some("abc123.webp".into())
    );
    assert_eq!(
        sanitize_thumb_filename("/a%20b.png"),
        Some("a b.png".into())
    );
}

#[test]
fn sanitize_rejects_traversal_and_separators() {
    assert_eq!(sanitize_thumb_filename("/"), None);
    assert_eq!(sanitize_thumb_filename("/../settings.json"), None);
    assert_eq!(sanitize_thumb_filename("/%2e%2e/settings.json"), None);
    assert_eq!(sanitize_thumb_filename("/a/b.png"), None);
    assert_eq!(sanitize_thumb_filename("/a%2Fb.png"), None);
    assert_eq!(sanitize_thumb_filename("/a%5Cb.png"), None);
}

#[test]
fn thumb_filename_accepts_plain_names() {
    assert!(is_safe_thumb_filename("abc123.webp"));
    assert!(is_safe_thumb_filename("thumbnail_abc123.png"));
    assert!(is_safe_thumb_filename("a b.jpg"));
}

#[test]
fn thumb_filename_rejects_traversal_and_separators() {
    // Attacker-controlled modworkshop image names must never escape the cache dir.
    assert!(!is_safe_thumb_filename(""));
    assert!(!is_safe_thumb_filename(".."));
    assert!(!is_safe_thumb_filename("../settings.json"));
    assert!(!is_safe_thumb_filename("..\\..\\settings.json"));
    assert!(!is_safe_thumb_filename("sub/dir.png"));
    assert!(!is_safe_thumb_filename("sub\\dir.png"));
    assert!(!is_safe_thumb_filename("/etc/passwd"));
    assert!(!is_safe_thumb_filename("C:\\Windows\\evil.bat"));
}

#[test]
fn content_type_by_extension() {
    assert_eq!(thumb_content_type("a.png"), "image/png");
    assert_eq!(thumb_content_type("a.jpg"), "image/jpeg");
    assert_eq!(thumb_content_type("a.webp"), "image/webp");
    assert_eq!(thumb_content_type("a.bin"), "application/octet-stream");
}

fn png_image(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let image = if alpha {
        image::DynamicImage::new_rgba8(width, height)
    } else {
        image::DynamicImage::new_rgb8(width, height)
    };
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

#[test]
fn card_names_preserve_original_identity_and_encoded_extension() {
    assert_eq!(
        super::card_cache_name("a.webp", false).unwrap(),
        "card_a.webp.jpg"
    );
    assert_eq!(
        super::card_cache_name("a.png", true).unwrap(),
        "card_a.png.png"
    );
    assert!(super::card_cache_name("../a.png", true).is_err());
    assert_eq!(thumb_content_type("card_a.webp.jpg"), "image/jpeg");
    assert_eq!(thumb_content_type("card_a.webp.png"), "image/png");
}

#[test]
fn card_does_not_upscale() {
    assert!(
        super::encode_card(std::io::Cursor::new(png_image(120, 60, false)))
            .unwrap()
            .is_none()
    );
    assert!(super::encode_card(std::io::Cursor::new(png_image(
        super::CARD_WIDTH,
        60,
        false
    )))
    .unwrap()
    .is_none());
}

#[test]
fn card_preserves_gif_animation() {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1000, 2)
        .write_to(&mut bytes, image::ImageFormat::Gif)
        .unwrap();
    assert!(super::encode_card(std::io::Cursor::new(bytes.into_inner()))
        .unwrap()
        .is_none());
}

#[test]
fn card_resizes_opaque_image_as_jpeg() {
    let (bytes, alpha) = super::encode_card(std::io::Cursor::new(png_image(1200, 600, false)))
        .unwrap()
        .unwrap();
    assert!(!alpha);
    assert_eq!(
        image::guess_format(&bytes).unwrap(),
        image::ImageFormat::Jpeg
    );
    let image = image::load_from_memory(&bytes).unwrap();
    assert_eq!((image.width(), image.height()), (960, 480));
}

#[test]
fn card_keeps_alpha_as_png() {
    let (bytes, alpha) = super::encode_card(std::io::Cursor::new(png_image(1200, 600, true)))
        .unwrap()
        .unwrap();
    assert!(alpha);
    assert_eq!(
        image::guess_format(&bytes).unwrap(),
        image::ImageFormat::Png
    );
    let image = image::load_from_memory(&bytes).unwrap();
    assert_eq!((image.width(), image.height()), (960, 480));
    assert_eq!(image.to_rgba8().get_pixel(0, 0).0[3], 0);
}

#[test]
fn card_rejects_corrupt_input() {
    assert!(super::encode_card(std::io::Cursor::new(b"not an image")).is_err());
}

#[test]
fn card_rejects_excessive_dimensions() {
    assert!(super::encode_card(std::io::Cursor::new(png_image(16385, 1, false))).is_err());
}

#[test]
fn card_applies_exif_orientation_before_sizing() {
    use image::ImageEncoder;
    // Little-endian TIFF with one IFD entry: Orientation (0x0112) = 6, rotate 90 clockwise.
    let exif = vec![
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    let stored = image::DynamicImage::new_rgb8(600, 1200).to_rgb8();
    let mut bytes = std::io::Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
    encoder.set_exif_metadata(exif).unwrap();
    encoder
        .write_image(&stored, 600, 1200, image::ExtendedColorType::Rgb8)
        .unwrap();
    let (card, _) = super::encode_card(std::io::Cursor::new(bytes.into_inner()))
        .unwrap()
        .unwrap();
    let card = image::load_from_memory(&card).unwrap();
    assert_eq!((card.width(), card.height()), (960, 480));
}

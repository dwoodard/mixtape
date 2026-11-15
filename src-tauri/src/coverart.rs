//! Downloading a cover picture from a web address so it can be embedded in song files.

use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageFormat};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use std::io::Read;
use std::time::Duration;

/// Downloads larger than this are refused before they are decoded.
const MAX_DOWNLOAD_BYTES: u64 = 15 * 1024 * 1024;
/// Longest side of the picture stored in a file, in pixels. Bigger pictures are shrunk.
const MAX_SIDE: u32 = 1500;
const JPEG_QUALITY: u8 = 90;

/// Only https addresses are fetched, so nothing travels or redirects over plain http.
pub fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if !lower.starts_with("https://") || lower.len() <= "https://".len() || lower.contains(char::is_whitespace) {
        return Err("The cover art address must be a full https:// link.".into());
    }
    Ok(())
}

/// Downloads the picture at `url` and returns it as JPEG bytes ready for a tag.
/// A JPEG that is small enough is kept exactly as served; anything else (WebP, PNG) is converted.
pub fn fetch(url: &str) -> Result<Vec<u8>, String> {
    check_url(url)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                attempt.error("redirected away from https")
            } else if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Mixtape")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url.trim()).send().map_err(|e| format!("Couldn't download the picture: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The picture's server answered {}.", response.status()));
    }
    if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD_BYTES) {
        return Err("The picture is too large (over 15 MB).".into());
    }
    let mut bytes = Vec::new();
    response.take(MAX_DOWNLOAD_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("Couldn't download the picture: {e}"))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("The picture is too large (over 15 MB).".into());
    }
    to_jpeg(&bytes)
}

/// JPEG bytes for any picture the image library can read. Errors say the link is not a usable picture.
pub fn to_jpeg(source: &[u8]) -> Result<Vec<u8>, String> {
    let format = image::guess_format(source).map_err(|_| "That link is not a picture.".to_string())?;
    let image = image::load_from_memory(source).map_err(|_| "That link is not a picture the app can read.".to_string())?;
    let small_enough = image.width().max(image.height()) <= MAX_SIDE;
    if format == ImageFormat::Jpeg && small_enough {
        return Ok(source.to_vec());
    }
    let image = if small_enough { image } else { image.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Lanczos3) };
    let rgb = image.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::DynamicImage::new_rgba8(w, h).write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png).unwrap();
        out
    }

    #[test]
    fn only_full_https_links_are_accepted() {
        assert!(check_url("https://example.com/a.jpg").is_ok());
        for bad in ["http://example.com/a.jpg", "ftp://x/y", "file:///etc/passwd", "https://", "example.com/a.jpg", "https://a b/c"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn converts_png_to_jpeg_and_shrinks_big_pictures() {
        let out = to_jpeg(&png(40, 30)).unwrap();
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Jpeg);
        let big = to_jpeg(&png(3000, 1500)).unwrap();
        let decoded = image::load_from_memory(&big).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1500, 750));
    }

    #[test]
    fn keeps_a_small_jpeg_untouched_and_rejects_non_pictures() {
        let jpeg = to_jpeg(&png(20, 20)).unwrap();
        assert_eq!(to_jpeg(&jpeg).unwrap(), jpeg);
        assert!(to_jpeg(b"<html>not an image</html>").is_err());
    }

    /// Needs the internet, so it is skipped by default. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_and_converts_a_real_webp_cover() {
        let url = "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/41/f5/7c/41f57ce2-da14-3522-478d-591accd330f7/882652154450.jpg/632x632bb.webp";
        let jpeg = fetch(url).unwrap();
        assert_eq!(image::guess_format(&jpeg).unwrap(), ImageFormat::Jpeg);
        assert!(image::load_from_memory(&jpeg).unwrap().width() > 100);
    }
}

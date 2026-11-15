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

/// Where a cover picture can come from: an http(s) link, or an image file on this computer
/// (an absolute path, `~/…`, or a `file://` link).
pub fn check_source(source: &str) -> Result<(), String> {
    let text = source.trim();
    let lower = text.to_ascii_lowercase();
    let web = ["http://", "https://"].iter().find(|p| lower.starts_with(**p));
    let ok = match web {
        Some(prefix) => lower.len() > prefix.len() && !lower.contains(char::is_whitespace),
        None => local_path(text).is_some(),
    };
    if ok { Ok(()) } else { Err("The cover art must be an http(s) link or the path of a picture on this computer.".into()) }
}

/// The file a local source points at, or `None` when it is not a local source.
fn local_path(text: &str) -> Option<std::path::PathBuf> {
    let path = if let Some(rest) = text.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        std::path::PathBuf::from(percent_encoding::percent_decode_str(rest).decode_utf8().ok()?.into_owned())
    } else if let Some(rest) = text.strip_prefix("~/") {
        std::path::PathBuf::from(std::env::var("HOME").ok()?).join(rest)
    } else {
        std::path::PathBuf::from(text)
    };
    path.is_absolute().then_some(path)
}

/// Loads the picture at `source` and returns it as JPEG bytes ready for a tag.
/// A JPEG that is small enough is kept exactly as it is; anything else (WebP, PNG) is converted.
pub fn fetch(source: &str) -> Result<Vec<u8>, String> {
    check_source(source)?;
    let text = source.trim();
    if text.to_ascii_lowercase().starts_with("http") {
        return download(text);
    }
    let path = local_path(text).ok_or("The cover art must be an http(s) link or the path of a picture on this computer.")?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("Couldn't open the picture file: {e}"))?;
    if !meta.is_file() {
        return Err("That path is not a file.".into());
    }
    if meta.len() > MAX_DOWNLOAD_BYTES {
        return Err("The picture is too large (over 15 MB).".into());
    }
    to_jpeg(&std::fs::read(&path).map_err(|e| format!("Couldn't read the picture file: {e}"))?)
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" && attempt.url().scheme() != "http" {
                attempt.error("redirected to an unsupported address")
            } else if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Mixtape")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().map_err(|e| format!("Couldn't download the picture: {e}"))?;
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
    fn accepts_web_links_and_absolute_file_paths_only() {
        for good in ["https://example.com/a.jpg", "http://example.com/a.jpg", "/Users/me/Pictures/my cover.png", "file:///Users/me/a%20b.jpg", "~/Pictures/a.jpg"] {
            assert!(check_source(good).is_ok(), "{good}");
        }
        for bad in ["ftp://x/y", "https://", "http://a b/c", "example.com/a.jpg", "relative/a.jpg", "", "   "] {
            assert!(check_source(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn loads_a_local_picture_by_path_or_file_link_and_converts_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("my cover.png");
        std::fs::write(&file, png(30, 30)).unwrap();
        let by_path = fetch(file.to_str().unwrap()).unwrap();
        assert_eq!(image::guess_format(&by_path).unwrap(), ImageFormat::Jpeg);
        let link = format!("file://{}", file.to_str().unwrap().replace(' ', "%20"));
        assert_eq!(fetch(&link).unwrap(), by_path);
        assert!(fetch(dir.path().to_str().unwrap()).unwrap_err().contains("not a file"));
        assert!(fetch(dir.path().join("missing.png").to_str().unwrap()).is_err());
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

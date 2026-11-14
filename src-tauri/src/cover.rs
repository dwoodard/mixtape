//! Album cover art: found in the audio file's tags or as a picture in the same
//! folder, shrunk to a small JPEG once, and cached on disk. Served to the UI
//! through the `cover://` protocol.

use crate::track::is_audio_file;
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use lofty::file::TaggedFileExt;
use lofty::picture::PictureType;
use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};

/// Longest side of a cached thumbnail, in pixels.
const THUMBNAIL_SIZE: u32 = 300;
const JPEG_QUALITY: u8 = 85;
/// Folder pictures, best guess first. Matched on the file name without extension.
const FOLDER_NAMES: [&str; 5] = ["cover", "folder", "front", "album", "artwork"];
const FOLDER_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];
/// Pictures larger than this are ignored rather than decoded.
const MAX_SOURCE_BYTES: u64 = 25 * 1024 * 1024;

/// The cover image bytes for a track: the front cover embedded in its tags
/// (or any embedded picture), else a picture file next to it.
pub fn find_source(track: &Path) -> Option<Vec<u8>> {
    embedded(track).or_else(|| folder_picture(track))
}

fn embedded(track: &Path) -> Option<Vec<u8>> {
    let tagged = lofty::read_from_path(track).ok()?;
    let pictures: Vec<_> = tagged.tags().iter().flat_map(|t| t.pictures()).collect();
    pictures
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pictures.first())
        .map(|p| p.data().to_vec())
}

fn folder_picture(track: &Path) -> Option<Vec<u8>> {
    let dir = track.parent()?;
    let mut found: Vec<(usize, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
            let rank = FOLDER_NAMES.iter().position(|n| *n == stem)?;
            FOLDER_EXTENSIONS.contains(&ext.as_str()).then_some((rank, path))
        })
        .collect();
    found.sort();
    found
        .into_iter()
        .find(|(_, p)| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_SOURCE_BYTES))
        .and_then(|(_, p)| std::fs::read(p).ok())
}

/// Shrinks image bytes to a JPEG thumbnail. `None` if they are not a readable image.
pub fn thumbnail(source: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(source).ok()?;
    // `thumbnail` scales to fit, which would also enlarge small images.
    let small = if image.width() <= THUMBNAIL_SIZE && image.height() <= THUMBNAIL_SIZE {
        image.to_rgb8()
    } else {
        image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE).to_rgb8()
    };
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(small.as_raw(), small.width(), small.height(), ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

/// Thumbnails on disk, keyed by track path, modified time and size, so an
/// edited file gets a fresh lookup. "No cover" is remembered too, so missing
/// art is not searched for again on every launch.
#[derive(Clone)]
pub struct CoverCache {
    dir: PathBuf,
}

impl CoverCache {
    pub fn new(dir: PathBuf) -> Self {
        CoverCache { dir }
    }

    fn key(track: &Path) -> Option<String> {
        let meta = std::fs::metadata(track).ok()?;
        let modified = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a
        for byte in format!("{}|{modified}|{}", track.display(), meta.len()).bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        Some(format!("{hash:016x}"))
    }

    /// The cached thumbnail for `track`, creating it on first use.
    pub fn get(&self, track: &Path) -> Option<Vec<u8>> {
        let key = Self::key(track)?;
        let hit = self.dir.join(format!("{key}.jpg"));
        let miss = self.dir.join(format!("{key}.none"));
        if let Ok(bytes) = std::fs::read(&hit) {
            return Some(bytes);
        }
        if miss.exists() {
            return None;
        }
        let _ = std::fs::create_dir_all(&self.dir);
        match find_source(track).and_then(|bytes| thumbnail(&bytes)) {
            Some(jpeg) => {
                let tmp = hit.with_extension("jpg.tmp");
                if std::fs::write(&tmp, &jpeg).is_ok() {
                    let _ = std::fs::rename(&tmp, &hit);
                }
                Some(jpeg)
            }
            None => {
                let _ = std::fs::write(&miss, b"");
                None
            }
        }
    }

    /// Handles a `cover://localhost/<percent-encoded absolute path>` request.
    /// Only audio file paths are accepted, so this cannot be used to read other files.
    pub fn serve(&self, uri_path: &str) -> Option<Vec<u8>> {
        let decoded = percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8().ok()?;
        let path = Path::new(decoded.as_ref());
        if !path.is_absolute() || !is_audio_file(path) {
            return None;
        }
        self.get(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture};
    use lofty::tag::{Tag, TagExt, TagType};
    use std::io::Cursor;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        RgbImage::from_pixel(width, height, Rgb([200, 30, 30]))
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn fixture_mp3(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3");
        std::fs::copy(source, &path).unwrap();
        path
    }

    fn embed(path: &Path, image: Vec<u8>, kind: PictureType) {
        let tagged = lofty::read_from_path(path).unwrap();
        let mut tag = tagged.primary_tag().cloned().unwrap_or_else(|| Tag::new(TagType::Id3v2));
        tag.push_picture(Picture::unchecked(image).pic_type(kind).mime_type(MimeType::Png).build());
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }

    fn dimensions(jpeg: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory(jpeg).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn thumbnail_is_a_small_jpeg_keeping_aspect_ratio() {
        let jpeg = thumbnail(&png(1200, 600)).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG header");
        assert_eq!(dimensions(&jpeg), (300, 150));
    }

    #[test]
    fn small_images_are_not_enlarged_and_junk_is_rejected() {
        assert_eq!(dimensions(&thumbnail(&png(40, 40)).unwrap()), (40, 40));
        assert!(thumbnail(b"not an image").is_none());
    }

    #[test]
    fn finds_the_cover_embedded_in_the_file_preferring_the_front_cover() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        embed(&track, png(10, 10), PictureType::Other);
        embed(&track, png(20, 20), PictureType::CoverFront);

        let source = find_source(&track).unwrap();

        assert_eq!(dimensions(&source), (20, 20));
    }

    #[test]
    fn falls_back_to_a_picture_in_the_folder_by_name_priority() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        std::fs::write(dir.path().join("Artwork.png"), png(10, 10)).unwrap();
        std::fs::write(dir.path().join("FOLDER.PNG"), png(30, 30)).unwrap();
        std::fs::write(dir.path().join("holiday.png"), png(50, 50)).unwrap();

        let source = find_source(&track).unwrap();

        assert_eq!(dimensions(&source), (30, 30));
    }

    #[test]
    fn no_art_anywhere_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        std::fs::write(dir.path().join("notes.png"), png(10, 10)).unwrap();
        assert!(find_source(&track).is_none());
    }

    #[test]
    fn the_cache_stores_a_thumbnail_and_reuses_it() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        embed(&track, png(900, 900), PictureType::CoverFront);
        let cache = CoverCache::new(dir.path().join("covers"));

        let first = cache.get(&track).unwrap();
        assert_eq!(dimensions(&first), (300, 300));
        // Remove the source art: a cache hit must not need it.
        std::fs::write(dir.path().join("covers/stale-marker"), b"").unwrap();
        let cached_file = std::fs::read_dir(dir.path().join("covers"))
            .unwrap()
            .filter_map(Result::ok)
            .find(|e| e.path().extension().is_some_and(|x| x == "jpg"))
            .unwrap()
            .path();
        std::fs::write(&cached_file, b"CACHED").unwrap();

        assert_eq!(cache.get(&track).unwrap(), b"CACHED");
    }

    #[test]
    fn missing_art_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        let cache = CoverCache::new(dir.path().join("covers"));

        assert!(cache.get(&track).is_none());
        // Art appearing later is not noticed until the file changes (by design).
        std::fs::write(dir.path().join("cover.png"), png(10, 10)).unwrap();
        assert!(cache.get(&track).is_none());
        let markers = std::fs::read_dir(dir.path().join("covers")).unwrap().count();
        assert_eq!(markers, 1);
    }

    #[test]
    fn a_changed_file_gets_a_fresh_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "song.mp3");
        let cache = CoverCache::new(dir.path().join("covers"));
        assert!(cache.get(&track).is_none());

        embed(&track, png(100, 100), PictureType::CoverFront);

        assert_eq!(dimensions(&cache.get(&track).unwrap()), (100, 100));
    }

    #[test]
    fn serve_decodes_the_path_and_refuses_anything_but_audio_files() {
        let dir = tempfile::tempdir().unwrap();
        let track = fixture_mp3(dir.path(), "My Song #1.mp3");
        embed(&track, png(50, 50), PictureType::CoverFront);
        let secret = dir.path().join("secret.png");
        std::fs::write(&secret, png(50, 50)).unwrap();
        let cache = CoverCache::new(dir.path().join("covers"));

        let encoded = format!("/{}", utf8_percent_encode(&track.to_string_lossy()));
        assert!(cache.serve(&encoded).is_some());
        let not_audio = format!("/{}", utf8_percent_encode(&secret.to_string_lossy()));
        assert!(cache.serve(&not_audio).is_none());
        assert!(cache.serve("/relative/song.mp3").is_none());
        assert!(cache.serve("/%FF%FE.mp3").is_none());
    }

    fn utf8_percent_encode(s: &str) -> String {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
    }
}

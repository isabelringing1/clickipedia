//! Title normalization and the title-bucket hash.
//!
//! Both functions are mirrored in `src/wikiGraph/titles.js`; the shared vectors
//! in `fixtures/title-cases.json` keep the two implementations in lockstep.

use unicode_normalization::UnicodeNormalization;

/// Name recorded in the manifest so the browser can refuse unknown hashes.
pub const TITLE_HASH_NAME: &str = "fnv1a32-fmix32";

/// MediaWiki's hard limit on title length, in bytes.
pub const MAX_TITLE_BYTES: usize = 255;

/// FNV-1a over the title bytes followed by the MurmurHash3 finalizer.
///
/// Plain FNV-1a has weak low bits; the finalizer makes `hash % bucket_count`
/// well distributed for any bucket count.
pub fn hash_title(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

pub fn bucket_for(bytes: &[u8], bucket_count: u32) -> u32 {
    hash_title(bytes) % bucket_count
}

fn is_title_whitespace(c: char) -> bool {
    matches!(
        c,
        ' ' | '_'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{180E}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

fn is_ignored_format_char(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}')
}

/// Converts link text or a display title into MediaWiki database-key form for
/// a first-letter-capitalizing wiki such as English Wikipedia.
///
/// Returns `None` when nothing remains or the result exceeds 255 bytes.
pub fn normalize_title(input: &str) -> Option<String> {
    // A fragment never belongs to the title.
    let without_fragment = match input.find('#') {
        Some(index) => &input[..index],
        None => input,
    };

    let mut collapsed = String::with_capacity(without_fragment.len());
    let mut pending_separator = false;
    for c in without_fragment.nfc() {
        if is_ignored_format_char(c) {
            continue;
        }
        if is_title_whitespace(c) {
            pending_separator = true;
            continue;
        }
        if pending_separator && !collapsed.is_empty() {
            collapsed.push('_');
        }
        pending_separator = false;
        collapsed.push(c);
    }

    // A single leading colon forces a main-namespace link; drop it.
    let trimmed = match collapsed.strip_prefix(':') {
        Some(rest) => rest.trim_start_matches('_'),
        None => collapsed.as_str(),
    };
    if trimmed.is_empty() {
        return None;
    }

    let mut chars = trimmed.chars();
    let first = chars.next()?;
    let mut upper = first.to_uppercase();
    let mut out = String::with_capacity(trimmed.len());
    match (upper.next(), upper.next()) {
        // Only apply simple one-to-one uppercase mappings (so "ß" stays "ß").
        (Some(single), None) => out.push(single),
        _ => out.push(first),
    }
    out.push_str(chars.as_str());

    if out.len() > MAX_TITLE_BYTES {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_vectors() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("title-cases.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn hash_matches_shared_vectors() {
        let vectors = shared_vectors();
        assert_eq!(vectors["hashName"], TITLE_HASH_NAME);
        let cases = vectors["hash"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let title = case["title"].as_str().unwrap();
            let expected = case["hash"].as_u64().unwrap() as u32;
            assert_eq!(hash_title(title.as_bytes()), expected, "hash of {title:?}");
            assert_eq!(
                bucket_for(title.as_bytes(), 4) as u64,
                case["bucketOf4"].as_u64().unwrap(),
                "bucket of {title:?}"
            );
            assert_eq!(
                bucket_for(title.as_bytes(), 8192) as u64,
                case["bucketOf8192"].as_u64().unwrap(),
                "bucket of {title:?}"
            );
        }
    }

    #[test]
    fn normalization_matches_shared_vectors() {
        let vectors = shared_vectors();
        let cases = vectors["normalize"].as_array().unwrap();
        assert!(cases.len() >= 30);
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let expected = case["expected"].as_str();
            assert_eq!(normalize_title(input).as_deref(), expected, "input {input:?}");
        }
    }

    #[test]
    fn normalization_is_idempotent_on_shared_vectors() {
        for case in shared_vectors()["normalize"].as_array().unwrap() {
            if let Some(expected) = case["expected"].as_str() {
                assert_eq!(normalize_title(expected).as_deref(), Some(expected));
            }
        }
    }

    #[test]
    fn normalizes_spaces_and_case() {
        assert_eq!(
            normalize_title("incremental game").as_deref(),
            Some("Incremental_game")
        );
        assert_eq!(
            normalize_title("  Cookie__ Clicker_ ").as_deref(),
            Some("Cookie_Clicker")
        );
        assert_eq!(normalize_title("Idle game#History").as_deref(), Some("Idle_game"));
        assert_eq!(normalize_title(":Cookie Clicker").as_deref(), Some("Cookie_Clicker"));
    }

    #[test]
    fn keeps_interior_case_and_punctuation() {
        assert_eq!(normalize_title("iPhone").as_deref(), Some("IPhone"));
        assert_eq!(
            normalize_title("2001: A Space Odyssey").as_deref(),
            Some("2001:_A_Space_Odyssey")
        );
    }

    #[test]
    fn handles_unicode() {
        assert_eq!(normalize_title("école").as_deref(), Some("École"));
        // Decomposed e + combining acute composes under NFC.
        assert_eq!(normalize_title("Cafe\u{0301}").as_deref(), Some("Café"));
        // No single-character uppercase form.
        assert_eq!(normalize_title("ßeta").as_deref(), Some("ßeta"));
        assert_eq!(normalize_title("a\u{00A0}b").as_deref(), Some("A_b"));
        assert_eq!(normalize_title("\u{200E}Foo\u{200F}").as_deref(), Some("Foo"));
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert_eq!(normalize_title(""), None);
        assert_eq!(normalize_title(" _ "), None);
        assert_eq!(normalize_title("#fragment"), None);
        assert_eq!(normalize_title(&"a".repeat(256)), None);
        assert!(normalize_title(&"a".repeat(255)).is_some());
    }
}

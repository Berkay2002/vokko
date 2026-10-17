//! Guard for design §9.7: the bot must never report plays to Spotify (history, recently played, Wrapped, friend activity).
//! In librespot the only code that writes play state is Connect (`librespot-connect`: Spirc, `put_connect_state_*`, the dealer
//! websocket). Without it the bot is a plain AP session with a local `Player`. This fails if any of it comes back.

use std::path::Path;

const FORBIDDEN_IN_SOURCE: &[&str] =
    &["librespot_connect", "librespot_discovery", "Spirc", "put_connect_state", "delete_connect_state", "dealer()", "mercury()"];

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn manifest_has_no_connect_crates() {
    let manifest = std::fs::read_to_string(root().join("Cargo.toml")).unwrap();
    for name in ["librespot-connect", "librespot-discovery"] {
        assert!(!manifest.contains(name), "{name} in Cargo.toml: it can report playback state");
    }
}

#[test]
fn lockfile_has_no_connect_crates() {
    let lock = std::fs::read_to_string(root().join("../../Cargo.lock")).unwrap();
    for name in ["librespot-connect", "librespot-discovery"] {
        assert!(!lock.contains(&format!("name = \"{name}\"")), "{name} is in the workspace lock file");
    }
}

#[test]
fn sources_do_not_touch_play_state_apis() {
    for entry in std::fs::read_dir(root().join("src")).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        for word in FORBIDDEN_IN_SOURCE {
            assert!(!text.contains(word), "{} uses {word}", path.display());
        }
    }
}

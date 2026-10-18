//! Workspace tasks and dependency-layer enforcement.
use serde_json::Value;
use std::path::Path;
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let action = std::env::args().nth(1).unwrap_or_else(|| "help".into());
    match action.as_str() {
        "layers" => layers()?,
        "privacy" => privacy()?,
        "help" | "--help" => {
            println!(
                "cargo xtask layers — reject UI dependencies in shared Rust crates\ncargo xtask privacy — fail when tracked files match the private personal-data denylist"
            )
        }
        other => return Err(format!("unknown task {other}; use cargo xtask --help").into()),
    }
    Ok(())
}

fn layers() -> Result<(), Box<dyn std::error::Error>> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo).args(["metadata", "--no-deps", "--format-version", "1"]).output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    let metadata: Value = serde_json::from_slice(&output.stdout)?;
    let packages = metadata.get("packages").and_then(Value::as_array).ok_or("missing Cargo packages")?;
    let members = metadata.get("workspace_members").and_then(Value::as_array).ok_or("missing Cargo workspace members")?;
    let levels = [("vokko-protocol", 0_u8), ("vokko-platform", 0), ("vokko-engine", 1), ("vokko-server", 1), ("vokko-loadtest", 2)];
    let mut violations = Vec::new();
    for package in packages {
        if !members.contains(package.get("id").ok_or("missing package id")?) {
            continue;
        }
        let name = package.get("name").and_then(Value::as_str).ok_or("missing package name")?;
        if matches!(name, "vokko-desktop" | "vokko-cli" | "stremio-bot" | "spotify-bot" | "xtask") {
            continue;
        }
        let level =
            levels.iter().find(|(entry, _)| *entry == name).map(|(_, level)| *level).ok_or_else(|| format!("register new crate {name} in the layer table"))?;
        let dependencies = package.get("dependencies").and_then(Value::as_array).ok_or("missing dependencies")?;
        for dependency in dependencies {
            if dependency.get("kind").and_then(Value::as_str) == Some("dev") {
                continue;
            }
            let dep = dependency.get("name").and_then(Value::as_str).ok_or("missing dependency name")?;
            if ["tauri", "egui", "eframe", "winit", "iced", "gpui", "rfd"]
                .iter()
                .any(|ui| dep == *ui || dep.starts_with(&format!("{ui}-")) || dep.starts_with(&format!("{ui}_")))
            {
                violations.push(format!("{name}: UI dependency {dep} belongs in an app shell"));
            }
            if dep.starts_with("vokko-") {
                match levels.iter().find(|(entry, _)| *entry == dep) {
                    Some((_, dependency_level)) if *dependency_level < level => (),
                    _ => violations.push(format!("{name}: dependency {dep} must be in a lower layer")),
                }
            }
        }
    }
    if !violations.is_empty() {
        return Err(violations.join("\n").into());
    }
    println!("Layer boundaries hold: protocol/platform → engine → app shells.");
    Ok(())
}

const DENYLIST_FILE: &str = ".private/denylist.txt";
const DENYLIST_ENV: &str = "VOKKO_PRIVACY_DENYLIST";
/// Always checked, even without a private denylist: the owner's drive and notes paths must not return to tracked files.
const BUILTIN_PATTERNS: [&str; 2] = [r"E:[\\/]+Dev\b", r"\.me[\\/]+projects"];

/// PCRE patterns, one per line; blank lines and `#` comment lines are ignored.
fn parse_patterns(text: &str) -> Vec<String> {
    text.lines().map(|line| line.trim_end_matches('\r')).filter(|line| !line.trim().is_empty() && !line.starts_with('#')).map(str::to_owned).collect()
}

/// The local file wins over the environment value; no source or no patterns means the guard is skipped.
fn load_patterns(file_text: Option<&str>, env_text: Option<&str>) -> Vec<String> {
    file_text.map(parse_patterns).filter(|patterns| !patterns.is_empty()).or_else(|| env_text.map(parse_patterns)).unwrap_or_default()
}

/// Reduces `git grep -n` output (`path:line:text`) to `path:line`, so CI logs never echo the matched text.
fn locations(grep_output: &str) -> Vec<String> {
    grep_output.lines().map(|line| line.splitn(3, ':').take(2).collect::<Vec<_>>().join(":")).collect()
}

fn privacy() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("xtask has no parent directory")?;
    let file_text = std::fs::read_to_string(root.join(DENYLIST_FILE)).ok();
    let env_text = std::env::var(DENYLIST_ENV).ok();
    let mut patterns = load_patterns(file_text.as_deref(), env_text.as_deref());
    patterns.extend(BUILTIN_PATTERNS.map(str::to_owned));
    let mut command = Command::new("git");
    command.current_dir(root).args(["grep", "-n", "-I", "-i", "-P"]);
    for pattern in &patterns {
        command.args(["-e", pattern]);
    }
    command.args(["--", ".", ":(exclude,glob)**/Cargo.lock", ":(exclude,glob)**/package-lock.json"]);
    let output = command.output()?;
    match output.status.code() {
        Some(0) => {
            let hits = locations(&String::from_utf8_lossy(&output.stdout));
            eprintln!("{}", hits.join("\n"));
            Err(format!("{} tracked line(s) match the privacy denylist (file:line listed above)", hits.len()).into())
        }
        Some(1) => {
            println!("Privacy guard passed: {} pattern(s), no matches in tracked files.", patterns.len());
            Ok(())
        }
        _ => Err(format!("git grep failed: {}", String::from_utf8_lossy(&output.stderr).trim()).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_patterns_and_skips_blanks_comments_and_cr() {
        assert_eq!(parse_patterns("foo\r\n\n# note\n  \nba+r\n"), ["foo", "ba+r"]);
    }

    #[test]
    fn file_wins_over_env_and_empty_sources_skip() {
        assert_eq!(load_patterns(Some("a"), Some("b")), ["a"]);
        assert_eq!(load_patterns(None, Some("b\nc")), ["b", "c"]);
        assert_eq!(load_patterns(Some("# only a comment\n"), Some("b")), ["b"]);
        assert!(load_patterns(None, None).is_empty());
        assert!(load_patterns(Some(""), Some("\n")).is_empty());
    }

    #[test]
    fn locations_drop_the_matched_text() {
        assert_eq!(locations("src/a.rs:12:let x = 1: y\nREADME.md:3:text\n"), ["src/a.rs:12", "README.md:3"]);
    }
}

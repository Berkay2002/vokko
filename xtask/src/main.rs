//! Workspace tasks and dependency-layer enforcement.
use serde_json::Value;
use std::path::Path;
use std::process::{Command, Stdio};

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

/// PCRE patterns with their 1-based line numbers; blank lines and `#` comment lines are ignored.
fn parse_patterns(text: &str) -> Vec<(usize, String)> {
    text.lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line.trim_end_matches('\r')))
        .filter(|(_, line)| !line.trim().is_empty() && !line.starts_with('#'))
        .map(|(number, line)| (number, line.to_owned()))
        .collect()
}

/// The local file wins over the environment value; no source or no patterns means the guard is skipped.
fn load_patterns(file_text: Option<&str>, env_text: Option<&str>) -> Vec<(usize, String)> {
    file_text.map(parse_patterns).filter(|patterns| !patterns.is_empty()).or_else(|| env_text.map(parse_patterns)).unwrap_or_default()
}

/// Reduces `git grep -n` output (`path:line:text`) to `path:line`, so CI logs never echo the matched text.
fn locations(grep_output: &str) -> Vec<String> {
    grep_output.lines().map(|line| line.splitn(3, ':').take(2).collect::<Vec<_>>().join(":")).collect()
}

/// Line numbers of patterns the grep cannot compile. It compiles every pattern before it reads a file, so grepping a path that
/// does not exist exits 1 for a valid pattern and 128 for a bad one. Output is discarded: it can echo the pattern.
fn invalid_lines(root: &Path, patterns: &[(usize, String)]) -> Result<Vec<usize>, Box<dyn std::error::Error>> {
    let mut bad = Vec::new();
    for (number, pattern) in patterns {
        let status = Command::new("git")
            .current_dir(root)
            .args(["grep", "-q", "-I", "-i", "-P", "-e", pattern, "--", ".xtask-no-such-path"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !matches!(status.code(), Some(0 | 1)) {
            bad.push(*number);
        }
    }
    Ok(bad)
}

fn privacy() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("xtask has no parent directory")?;
    let file_text = std::fs::read_to_string(root.join(DENYLIST_FILE)).ok();
    let env_text = std::env::var(DENYLIST_ENV).ok();
    let patterns = load_patterns(file_text.as_deref(), env_text.as_deref());
    if patterns.is_empty() {
        println!("Privacy guard skipped: no denylist (set {DENYLIST_ENV} or create {DENYLIST_FILE}).");
        return Ok(());
    }
    let bad = invalid_lines(root, &patterns)?;
    if !bad.is_empty() {
        let lines: Vec<String> = bad.iter().map(usize::to_string).collect();
        return Err(format!("the privacy denylist has {} pattern(s) that cannot be compiled (line(s) {})", bad.len(), lines.join(", ")).into());
    }
    // No `-I`: binary files (images, fonts, PDFs) are searched too, and a hit prints only `Binary file <path> matches`, never the
    // matched bytes. Metadata stored as UTF-16 or compressed (PNG zTXt, PDF streams) still cannot match.
    let mut hits = grep(root, &patterns, &["--", ".", ":(exclude,glob)**/Cargo.lock", ":(exclude,glob)**/package-lock.json"])?;
    // File names are checked as well: the tracked paths go to a git-ignored file that is searched by line number.
    let list = Command::new("git").current_dir(root).args(["-c", "core.quotePath=false", "ls-files"]).output()?;
    if !list.status.success() {
        return Err("git ls-files failed".into());
    }
    let paths = String::from_utf8_lossy(&list.stdout).into_owned();
    std::fs::create_dir_all(root.join("target"))?;
    std::fs::write(root.join(PATH_LIST), &paths)?;
    let path_hits = grep(root, &patterns, &["--no-index", "--", PATH_LIST]);
    let _ = std::fs::remove_file(root.join(PATH_LIST));
    let names: Vec<&str> = paths.lines().collect();
    hits.extend(line_numbers(&path_hits?).into_iter().filter_map(|n| names.get(n - 1)).map(|path| format!("{path} (file name)")));
    if hits.is_empty() {
        println!("Privacy guard passed: {} pattern(s), no matches in tracked files or file names.", patterns.len());
        Ok(())
    } else {
        eprintln!("{}", hits.join("\n"));
        Err(format!("{} tracked line(s), binary file(s) or file name(s) match the privacy denylist (listed above)", hits.len()).into())
    }
}

/// Where `privacy` lists the tracked paths for the file-name check (under the git-ignored `target`).
const PATH_LIST: &str = "target/xtask-privacy-paths.txt";

/// `git grep -n -i -P` with every pattern, reduced to `path:line` by `locations`; an empty list means no match.
fn grep(root: &Path, patterns: &[(usize, String)], tail: &[&str]) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut command = Command::new("git");
    command.current_dir(root).args(["grep", "-n", "-i", "-P"]);
    for (_, pattern) in patterns {
        command.args(["-e", pattern]);
    }
    command.args(tail);
    // stderr is discarded: on failure it can echo the private patterns into CI logs.
    let output = command.stderr(Stdio::null()).output()?;
    match output.status.code() {
        Some(0) => Ok(locations(&String::from_utf8_lossy(&output.stdout))),
        Some(1) => Ok(Vec::new()),
        code => Err(format!("the privacy search failed (exit status {})", code.map_or_else(|| "unknown".to_owned(), |c| c.to_string())).into()),
    }
}

/// The line numbers in `path:line` locations.
fn line_numbers(locations: &[String]) -> Vec<usize> {
    locations.iter().filter_map(|location| location.rsplit(':').next()?.parse().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_patterns_and_skips_blanks_comments_and_cr() {
        assert_eq!(parse_patterns("foo\r\n\n# note\n  \nba+r\n"), [(1, "foo".to_owned()), (5, "ba+r".to_owned())]);
    }

    #[test]
    fn file_wins_over_env_and_empty_sources_skip() {
        assert_eq!(load_patterns(Some("a"), Some("b")), [(1, "a".to_owned())]);
        assert_eq!(load_patterns(None, Some("b\nc")), [(1, "b".to_owned()), (2, "c".to_owned())]);
        assert_eq!(load_patterns(Some("# only a comment\n"), Some("b")), [(1, "b".to_owned())]);
        assert!(load_patterns(None, None).is_empty());
        assert!(load_patterns(Some(""), Some("\n")).is_empty());
    }

    #[test]
    fn locations_drop_the_matched_text() {
        assert_eq!(locations("src/a.rs:12:let x = 1: y\nREADME.md:3:text\n"), ["src/a.rs:12", "README.md:3"]);
        assert_eq!(locations("Binary file icon.png matches\n"), ["Binary file icon.png matches"]);
    }

    #[test]
    fn line_numbers_come_from_the_locations() {
        assert_eq!(line_numbers(&locations("target/list.txt:3:a/zzqq.png\ntarget/list.txt:12:b\n")), [3, 12]);
    }

    #[test]
    fn bad_pattern_is_reported_by_line_number_only() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask has a parent");
        let patterns = parse_patterns("fine\nunclosed-group(\n(?i)ok(?=x)\n");
        assert_eq!(invalid_lines(root, &patterns).expect("git runs"), [2]);
    }
}

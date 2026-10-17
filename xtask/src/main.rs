//! Workspace tasks and dependency-layer enforcement.
use serde_json::Value;
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let action = std::env::args().nth(1).unwrap_or_else(|| "help".into());
    match action.as_str() {
        "layers" => layers()?,
        "help" | "--help" => println!("cargo xtask layers — reject UI dependencies in shared Rust crates"),
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
        if matches!(name, "vokko-desktop" | "vokko-cli" | "stremio-bot" | "xtask") {
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

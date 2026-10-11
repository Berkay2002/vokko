#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::State;
use vokko_engine::Session;
use vokko_platform::{app_dirs, logging};
use vokko_protocol::CommandRequest;

#[tauri::command]
fn dispatch(request: CommandRequest, session: State<'_, Mutex<Session>>) -> Result<serde_json::Value, String> {
    let mut session = session.lock().map_err(|_| "session unavailable; please restart Vokko".to_owned())?;
    session.dispatch(request).map_err(|error| error.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let logger = logging::install();
    if let Some(dir) = app_dirs::config_dir()
        && let Some(logger) = logger
        && let Err(error) = logger.attach_dir(&dir.join("logs"))
    {
        eprintln!("Vokko: {error}");
    }
    log::info!("starting Vokko local scaffold");
    tauri::Builder::default().manage(Mutex::new(Session::demo()?)).invoke_handler(tauri::generate_handler![dispatch]).run(tauri::generate_context!())?;
    Ok(())
}

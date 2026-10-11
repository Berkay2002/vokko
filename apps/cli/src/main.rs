//! Headless access to the same session and commands as the desktop shell.
use std::io::{self, BufRead, Write};
use vokko_engine::Session;
use vokko_protocol::CommandRequest;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = Session::demo()?;
    let command = std::env::args().nth(1).unwrap_or_else(|| "inspect".into());
    let mut out = io::BufWriter::new(io::stdout().lock());
    match command.as_str() {
        "inspect" => writeln!(out, "{}", serde_json::to_string_pretty(session.snapshot())?)?,
        "commands" => writeln!(out, "{}", serde_json::to_string_pretty(&session.commands())?)?,
        "serve" => {
            // Local stdin/stdout only; no network listener or authentication surface.
            for line in io::stdin().lock().lines() {
                let line = line?;
                let reply = match serde_json::from_str::<CommandRequest>(&line) {
                    Ok(request) => match session.dispatch(request) {
                        Ok(result) => serde_json::json!({"ok": true, "result": result}),
                        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
                    },
                    Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
                };
                writeln!(out, "{reply}")?;
                out.flush()?;
            }
        }
        "help" | "--help" | "-h" => {
            writeln!(out, "vokko-cli [inspect | commands | serve]\nserve accepts one JSON CommandRequest per line; state is local and temporary.")?
        }
        other => return Err(format!("unknown subcommand: {other}; use --help").into()),
    }
    out.flush()?;
    Ok(())
}

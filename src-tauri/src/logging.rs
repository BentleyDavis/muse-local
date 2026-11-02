use std::io::Write;
use std::sync::Mutex;

static LOG_LOCK: Mutex<()> = Mutex::new(());
const MAX_LOG_BYTES: u64 = 5_000_000;

#[tauri::command]
pub async fn append_console_log(source: String, level: String, text: String) -> Result<(), String> {
    crate::run_blocking(move || {
        let _guard = LOG_LOCK.lock().map_err(|e| e.to_string())?;
        if !matches!(level.as_str(), "info" | "ok" | "warn" | "err") {
            return Err("invalid log level".into());
        }
        let dir = crate::config::app_dir().join("logs");
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create log folder: {e}"))?;
        let path = dir.join("console.log");
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.len() >= MAX_LOG_BYTES => {
                let backup = dir.join("console.previous.log");
                match std::fs::remove_file(&backup) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(format!("cannot remove previous log: {error}")),
                }
                std::fs::rename(&path, backup)
                    .map_err(|e| format!("cannot rotate console log: {e}"))?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect console log: {error}")),
        }
        let mut text: String = text.chars().take(16_384).collect();
        if let Some(token) = crate::secret::load_token()? {
            if !token.is_empty() {
                text = text.replace(&token, "[REDACTED]");
            }
        }
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let line = serde_json::json!({
            "timestampMs": timestamp,
            "source": source.chars().take(80).collect::<String>(),
            "level": level,
            "text": text,
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("cannot open console log: {e}"))?;
        writeln!(file, "{line}").map_err(|e| format!("cannot write console log: {e}"))
    })
    .await
}

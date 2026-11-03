use serde::Serialize;
use std::path::PathBuf;

const MAX_SCRIPT_BYTES: u64 = 1_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLibrary {
    directory: String,
    files: Vec<String>,
}

fn scripts_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts");
    dir.canonicalize()
        .map_err(|e| format!("cannot resolve scripts folder: {e}"))
}

#[tauri::command]
pub fn list_scripts() -> Result<ScriptLibrary, String> {
    let dir = scripts_dir()?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("cannot list scripts: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot read script entry: {e}"))?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if valid_name(&name) {
                files.push(name);
            }
        }
    }
    files.sort();
    Ok(ScriptLibrary {
        directory: dir.to_string_lossy().to_string(),
        files,
    })
}

fn valid_name(name: &str) -> bool {
    name.strip_suffix(".js").is_some_and(|stem| {
        !stem.is_empty()
            && stem
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}

#[tauri::command]
pub fn load_script(name: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err(
            "script name must use letters, digits, hyphens or underscores and end in .js".into(),
        );
    }
    let dir = scripts_dir()?;
    let path = dir
        .join(&name)
        .canonicalize()
        .map_err(|e| format!("cannot resolve {name}: {e}"))?;
    if path.parent() != Some(dir.as_path()) {
        return Err("script must be directly inside the scripts folder".into());
    }
    let metadata = path
        .metadata()
        .map_err(|e| format!("cannot inspect {name}: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SCRIPT_BYTES {
        return Err("script must be a file no larger than 1,000,000 bytes".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {name}: {e}"))
}

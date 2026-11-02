fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_sidebar_width",
            "site_navigate",
            "site_info",
            "site_run",
            "page_result",
            "reload_site",
            "get_config",
            "save_config",
            "set_firebase_token",
            "delete_firebase_token",
            "pointer_geometry",
            "mouse_path",
            "click_at",
            "type_text",
            "start_recording",
            "stop_recording",
            "recording_status",
            "list_recordings",
            "load_recording",
            "delete_recording",
            "screenshot",
        ]),
    ))
    .expect("failed to run tauri-build");
}

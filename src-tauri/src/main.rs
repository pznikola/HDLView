#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use hdlview_core::service::Service;
use tauri::Manager;
#[tauri::command]
async fn api(
    action: String,
    args: serde_json::Value,
    state: tauri::State<'_, Service>,
) -> Result<serde_json::Value, String> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.request(&action, args).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--wave-worker") {
        if let Err(e) = hdlview_core::waveprocess::worker_main() {
            eprintln!("{e:#}");
            std::process::exit(1)
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path().app_cache_dir()?;
            app.manage(Service::new(path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api])
        .run(tauri::generate_context!())
        .expect("Cannot launch HDLView");
}

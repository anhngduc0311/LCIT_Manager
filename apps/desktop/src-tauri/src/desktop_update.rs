use std::{sync::Mutex, thread, time::Duration};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct DesktopUpdate(Mutex<Option<(Update, Vec<u8>)>>);

pub fn start(app: AppHandle) {
    // Download in the background so the user can finish their current work.
    thread::spawn(move || loop {
        match tauri::async_runtime::block_on(download(&app)) {
            Ok(Some(update)) => {
                *app.state::<DesktopUpdate>().0.lock().unwrap() = Some(update);
                let _ = app
                    .notification()
                    .builder()
                    .title("Có bản cập nhật LCIT Manager")
                    .body("Bản mới sẽ được cài khi bạn chọn Thoát ở khay hệ thống.")
                    .show();
                break;
            }
            Ok(None) => {}
            Err(error) => eprintln!("LCIT update check: {error}"),
        }
        thread::sleep(Duration::from_secs(60 * 60));
    });
}

async fn download(app: &AppHandle) -> tauri_plugin_updater::Result<Option<(Update, Vec<u8>)>> {
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .restart_after_install(false)
        .build()?;
    let Some(mut update) = updater.check().await? else {
        return Ok(None);
    };
    update.timeout = Some(Duration::from_secs(30 * 60));
    let bytes = update.download(|_, _| {}, || {}).await?;
    Ok(Some((update, bytes)))
}

pub fn install_on_exit(app: &AppHandle) {
    let candidate = app.state::<DesktopUpdate>().0.lock().unwrap().take();
    if let Some((update, bytes)) = candidate {
        if let Err(error) = update.install(bytes) {
            eprintln!("LCIT update install: {error}");
        }
    }
}

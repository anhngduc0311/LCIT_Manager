#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launch;
mod ssh_terminal;
mod rdp;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ssh_terminal::Sessions::default())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![launch::launch_access, ssh_terminal::ssh_open, ssh_terminal::ssh_write, ssh_terminal::ssh_resize, ssh_terminal::ssh_close,
            rdp::rdp_open, rdp::rdp_resize, rdp::rdp_status, rdp::rdp_close])
        .setup(|app| {
            // T3.5: the app stays in the Windows tray so alert notifications keep arriving after the window is closed.
            let open = MenuItem::with_id(app, "open", "Mở LCIT Manager", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("LCIT Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; "Thoát" in the tray menu ends the app.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start LCIT Manager");
}

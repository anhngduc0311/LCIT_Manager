//! OpenSSH runs inside a native PTY; credentials and terminal output are never logged.
use crate::launch::{self, LaunchRequest};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex}};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};

struct Session {
    owner: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Drop for Session {
    fn drop(&mut self) { let _ = self.killer.kill(); }
}

#[derive(Default, Clone)]
pub struct Sessions(Arc<Mutex<HashMap<String, Session>>>);

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Output {
    Data { data: Vec<u8> },
    Exit { code: Option<u32> },
    Error { message: String },
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Kích thước terminal không hợp lệ".into());
    }
    Ok(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
}

fn validate_username(username: &str) -> Result<(), String> {
    if username.is_empty() || username.len() > 128 || username.starts_with('-') ||
        !username.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-@\\".contains(&c)) {
        return Err("Tên đăng nhập SSH không hợp lệ".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_open(window: WebviewWindow, request: LaunchRequest, username: String, cols: u16, rows: u16, output: Channel<Output>) -> Result<String, String> {
    let sessions = window.state::<Sessions>().inner().clone();
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        launch::validate_authorization_id(&request.authorization_id)?;
        if request.protocol != "ssh" { return Err("Chỉ hỗ trợ SSH".into()); }
        let spec = launch::build_spec(&request.protocol, &request.host, request.port)?;
        validate_username(&username)?;
        let program = launch::client_path(launch::Client::Ssh, &launch::system_root());
        if !program.is_file() { return Err("Cần cài OpenSSH Client trong tính năng tùy chọn của Windows".into()); }
        let pair = portable_pty::native_pty_system().openpty(size(cols, rows)?).map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(program);
        command.env("TERM", "xterm-256color");
        command.args(["-tt", "-l", &username]);
        command.args(&spec.args);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let session = Session { owner, master: pair.master, writer, killer: child.clone_killer() };
        let id = request.authorization_id.clone();
        {
            let mut all = sessions.0.lock().map_err(|e| e.to_string())?;
            if all.contains_key(&id) { return Err("Phiên SSH đã tồn tại".into()); }
            if all.len() >= 8 { return Err("Đã đạt giới hạn 8 phiên SSH".into()); }
            all.insert(id.clone(), session);
        }
        launch::log_attempt(&app, &request, &launch::LaunchOutcome {
            status: launch::Status::Started, protocol: "ssh".into(), detail: "embedded PTY".into(), exit_code: None, pid: child.process_id(),
        });
        let reading_sessions = sessions.clone();
        let reading_id = id.clone();
        let reading_output = output.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => if reading_output.send(Output::Data { data: buffer[..n].to_vec() }).is_err() { break; },
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => { let _ = reading_output.send(Output::Error { message: e.to_string() }); break; }
                }
            }
            let removed = reading_sessions.0.lock().ok().and_then(|mut all| all.remove(&reading_id));
            drop(removed);
        });
        let result_id = id.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            // Closing ConPTY releases its output pipe after the child exits.
            let removed = sessions.0.lock().ok().and_then(|mut all| all.remove(&id));
            drop(removed);
            // The reader drains the final PTY bytes before publishing the exit marker.
            let _ = reader_thread.join();
            launch::log_attempt(&app, &request, &launch::LaunchOutcome {
                status: launch::Status::ExitedEarly, protocol: "ssh".into(), detail: "embedded PTY ended".into(), exit_code: code.map(i64::from), pid: None,
            });
            let _ = output.send(Output::Exit { code });
        });
        Ok(result_id)
    }).await.map_err(|e| e.to_string())?
}

fn with_session<T>(window: &WebviewWindow, sessions: &Sessions, id: &str, action: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut all = sessions.0.lock().map_err(|e| e.to_string())?;
    let session = all.get_mut(id).filter(|s| s.owner == window.label()).ok_or("Phiên SSH đã đóng")?;
    action(session)
}

#[tauri::command]
pub async fn ssh_write(window: WebviewWindow, sessions: State<'_, Sessions>, id: String, data: String) -> Result<(), String> {
    if data.len() > 65536 { return Err("Dữ liệu nhập quá lớn".into()); }
    let sessions = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_session(&window, &sessions, &id, |s| s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ssh_resize(window: WebviewWindow, sessions: State<'_, Sessions>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let dimensions = size(cols, rows)?;
    let sessions = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_session(&window, &sessions, &id, |s| s.master.resize(dimensions).map_err(|e| e.to_string())))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ssh_close(window: WebviewWindow, sessions: State<Sessions>, id: String) -> Result<(), String> {
    let mut all = sessions.0.lock().map_err(|e| e.to_string())?;
    let removed = if all.get(&id).is_some_and(|s| s.owner == window.label()) { all.remove(&id) } else { None };
    drop(all);
    drop(removed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_size_is_bounded() {
        assert!(size(80, 24).is_ok());
        for (cols, rows) in [(0, 24), (501, 24), (80, 0), (80, 301)] { assert!(size(cols, rows).is_err()); }
    }
    #[test]
    fn username_rejects_options_and_shell_syntax() {
        for value in ["root", "deploy-user", "user@example", "DOMAIN\\user"] { assert!(validate_username(value).is_ok()); }
        for value in ["", "-oProxyCommand=calc", "root;calc", "user\nroot", "user name", "user\"name"] { assert!(validate_username(value).is_err()); }
    }

    #[test]
    #[cfg(windows)]
    fn native_pty_accepts_input_and_drains_output() {
        let pair = portable_pty::native_pty_system().openpty(size(80, 24).unwrap()).unwrap();
        let mut command = CommandBuilder::new(launch::system_root().join("System32").join("cmd.exe"));
        command.args(["/D", "/Q"]);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let output = std::thread::spawn(move || { let mut bytes = Vec::new(); reader.read_to_end(&mut bytes).unwrap(); bytes });
        // ConPTY inherits the cursor and waits for a terminal cursor report.
        writer.write_all(b"\x1b[1;1R").unwrap();
        writer.flush().unwrap();
        pair.master.resize(size(100, 30).unwrap()).unwrap();
        writer.write_all(b"echo LCIT_PTY_OK\r\nexit /b 7\r\n").unwrap();
        writer.flush().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if std::time::Instant::now() >= deadline { child.kill().unwrap(); panic!("PTY child did not exit"); }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        drop(writer);
        drop(pair.master);
        let bytes = output.join().unwrap();
        assert_eq!(status.exit_code(), 7);
        assert!(String::from_utf8_lossy(&bytes).contains("LCIT_PTY_OK"));
    }
}

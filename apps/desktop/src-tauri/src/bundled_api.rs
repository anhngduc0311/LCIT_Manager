use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, ErrorKind},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

const ARCHIVE: &[u8] = include_bytes!("../target/bundled-api.tar.gz");
const ADDRESS: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST), 4000);

#[derive(Default)]
pub struct BundledApi(Mutex<Option<Child>>);

fn extract_runtime(data_dir: &Path) -> io::Result<PathBuf> {
    let runtime = data_dir.join(format!("api-{:x}", Sha256::digest(ARCHIVE)));
    if runtime.is_dir() {
        return Ok(runtime);
    }
    let staging = tempfile::Builder::new().prefix("api-extract-").tempdir_in(data_dir)?;
    tar::Archive::new(GzDecoder::new(ARCHIVE)).unpack(staging.path())?;
    fs::rename(staging.path(), &runtime)?;
    Ok(runtime)
}

fn launch_api(data_dir: &Path) -> io::Result<Child> {
    fs::create_dir_all(data_dir)?;
    let runtime = extract_runtime(data_dir)?;
    let log = File::create(data_dir.join("api.log"))?;
    let mut config_arg = OsString::from("--env-file-if-exists=");
    config_arg.push(data_dir.join("api.env"));
    Command::new(runtime.join("node.exe"))
        .arg(config_arg)
        .arg("--require")
        .arg(runtime.join("parent-watch.cjs"))
        .arg(runtime.join("apps/api/dist/main.js"))
        .current_dir(data_dir)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("LCIT_DESKTOP_DATA_DIR", data_dir)
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", "4000")
        .env("API_CORS_ORIGINS", "http://tauri.localhost")
        .env("API_DOCS_ENABLED", "off")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
}

fn port_is_open() -> bool {
    TcpStream::connect_timeout(&ADDRESS, Duration::from_millis(250)).is_ok()
}

fn ensure_api(state: &BundledApi, data_dir: &Path) -> io::Result<()> {
    let mut child = state.0.lock().map_err(|_| io::Error::other("API state unavailable"))?;
    if port_is_open() {
        return Ok(());
    }
    if let Some(process) = child.as_mut() {
        if process.try_wait()?.is_some() {
            *child = None;
        }
    }
    if child.is_none() {
        *child = Some(launch_api(data_dir)?);
    }
    let process = child.as_mut().expect("API process was started");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if port_is_open() {
            return Ok(());
        }
        if let Some(status) = process.try_wait()? {
            return Err(io::Error::other(format!("API exited with {status}")));
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(io::Error::new(ErrorKind::TimedOut, "API did not open port 4000"))
}

pub async fn ensure_local_api(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_api(&app.state::<BundledApi>(), &data_dir)
            .map_err(|error| format!("{error}. API log: {}", data_dir.join("api.log").display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

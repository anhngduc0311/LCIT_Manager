//! T4.2: opens the Windows SSH/RDP clients for a destination the API has just authorized.
//!
//! Rules (SPEC "SSH/RDP"): the client program is fixed per protocol and resolved from the Windows system
//! folder (never from PATH or the current directory), every argument is validated and passed as its own
//! token (no shell, no interpolation), and the user signs in to the target directly in the client.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::PathBuf;
use tauri::Manager;

/// How long to watch a client after starting it. One still running after this is "started"; one that already
/// exited (for example ssh refusing the connection) is reported with its exit code. A refused connection takes
/// about 2 seconds on Windows loopback, so ssh gets a longer window than the graphical Remote Desktop client.
fn observe_ms(client: Client) -> u32 {
    match client {
        Client::Ssh => 4_000,
        Client::Rdp => 1_500,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    /// `authorizationId` of the API response; ties this attempt to the audit record.
    pub authorization_id: String,
    pub protocol: String,
    pub host: String,
    /// Wider than u16 so that an out-of-range value is reported as invalid instead of failing to deserialize.
    pub port: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The client is running after the observation window.
    Started,
    /// The client ended during the observation window; see `exit_code`.
    ExitedEarly,
    /// `ssh.exe` or `mstsc.exe` is not installed.
    ClientMissing,
    /// Windows refused to start the client.
    SpawnFailed,
    /// The destination failed validation; nothing was started.
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOutcome {
    pub status: Status,
    pub protocol: String,
    /// Short technical detail for logs and support, not a user-facing sentence.
    pub detail: String,
    pub exit_code: Option<i64>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    Ssh,
    Rdp,
}

/// A destination that passed validation, with the exact arguments for its client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub client: Client,
    pub args: Vec<String>,
}

fn valid_hostname(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

/// Accepts an IPv4/IPv6 literal (no zone, no brackets, no port) or an ASCII hostname that cannot be read as an option.
pub fn validate_host(host: &str) -> Result<(), String> {
    if host.parse::<IpAddr>().is_ok() || valid_hostname(host) {
        Ok(())
    } else {
        Err("host is not a plain IP address or hostname".into())
    }
}

pub fn validate_authorization_id(id: &str) -> Result<(), String> {
    let uuid_shape = id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if uuid_shape { Ok(()) } else { Err("authorizationId is not a UUID".into()) }
}

pub fn build_spec(protocol: &str, host: &str, port: u32) -> Result<LaunchSpec, String> {
    let client = match protocol {
        "ssh" => Client::Ssh,
        "rdp" => Client::Rdp,
        _ => return Err("protocol must be ssh or rdp".into()),
    };
    if !(1..=65_535).contains(&port) {
        return Err("port must be between 1 and 65535".into());
    }
    validate_host(host)?;
    let args = match client {
        // `--` ends option parsing, so the host can never be taken for an ssh option.
        Client::Ssh => vec!["-p".into(), port.to_string(), "--".into(), host.to_string()],
        Client::Rdp => {
            let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
            vec![format!("/v:{target}")]
        }
    };
    Ok(LaunchSpec { client, args })
}

fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// `<root>\System32\...`: the clients are Windows components, so they are never looked up through PATH.
fn client_path(client: Client, root: &std::path::Path) -> PathBuf {
    let system32 = root.join("System32");
    match client {
        Client::Ssh => system32.join("OpenSSH").join("ssh.exe"),
        Client::Rdp => system32.join("mstsc.exe"),
    }
}

pub enum Observed {
    Running { pid: u32 },
    Exited { pid: u32, code: u32 },
}

#[cfg(windows)]
fn start_process(program: &std::path::Path, args: &[String], new_console: bool, observe_ms: u32) -> std::io::Result<Observed> {
    use std::io::{Error, ErrorKind};
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, WaitForSingleObject, CREATE_NEW_CONSOLE, PROCESS_INFORMATION, STARTUPINFOW,
    };

    // Arguments were validated to plain tokens; refuse anything that would need quoting rather than guess.
    if args.iter().any(|arg| arg.is_empty() || arg.chars().any(|c| c.is_whitespace() || c == '"' || c == '\0')) {
        return Err(Error::new(ErrorKind::InvalidInput, "argument needs quoting"));
    }
    let wide = |text: &std::ffi::OsStr| -> Vec<u16> { text.encode_wide().chain(std::iter::once(0)).collect() };
    let application = wide(program.as_os_str());
    let mut command_line = format!("\"{}\"", program.display());
    for arg in args {
        command_line.push(' ');
        command_line.push_str(arg);
    }
    let mut command_line = wide(std::ffi::OsStr::new(&command_line));

    // SAFETY: both buffers are NUL-terminated and outlive the call; the structs are zero-initialised as the API requires.
    unsafe {
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        // No handle inheritance: a console client gets the new console as its own input and output.
        let created = CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            if new_console { CREATE_NEW_CONSOLE } else { 0 },
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut info,
        );
        if created == 0 {
            return Err(Error::last_os_error());
        }
        CloseHandle(info.hThread);
        let observed = if WaitForSingleObject(info.hProcess, observe_ms) == WAIT_OBJECT_0 {
            let mut code = 0u32;
            GetExitCodeProcess(info.hProcess, &mut code);
            Observed::Exited { pid: info.dwProcessId, code }
        } else {
            Observed::Running { pid: info.dwProcessId }
        };
        CloseHandle(info.hProcess);
        Ok(observed)
    }
}

#[cfg(not(windows))]
fn start_process(_program: &std::path::Path, _args: &[String], _new_console: bool, _observe_ms: u32) -> std::io::Result<Observed> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "SSH/RDP launch is only available on Windows"))
}

/// Validates, starts the client and watches it briefly. Blocks for up to `observe_ms`; call from a blocking thread.
pub fn launch_blocking(request: &LaunchRequest) -> LaunchOutcome {
    launch_from(request, &system_root())
}

/// Same as `launch_blocking`, with the Windows folder given explicitly so tests can point it at an empty folder.
fn launch_from(request: &LaunchRequest, root: &std::path::Path) -> LaunchOutcome {
    let outcome = |status, detail: String, exit_code, pid| LaunchOutcome {
        status,
        protocol: request.protocol.clone(),
        detail,
        exit_code,
        pid,
    };
    let spec = match validate_authorization_id(&request.authorization_id).and_then(|_| build_spec(&request.protocol, &request.host, request.port)) {
        Ok(spec) => spec,
        Err(reason) => return outcome(Status::Invalid, reason, None, None),
    };
    let program = client_path(spec.client, root);
    if !program.is_file() {
        return outcome(Status::ClientMissing, format!("{} not found", program.display()), None, None);
    }
    // ssh.exe is a console program and needs its own window; mstsc.exe is a windowed program.
    match start_process(&program, &spec.args, spec.client == Client::Ssh, observe_ms(spec.client)) {
        Ok(Observed::Running { pid }) => outcome(Status::Started, "running".into(), None, Some(pid)),
        Ok(Observed::Exited { pid, code }) => outcome(Status::ExitedEarly, "exited during observation".into(), Some(code as i64), Some(pid)),
        Err(error) => outcome(Status::SpawnFailed, error.to_string(), None, None),
    }
}

/// Seconds since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ` (days-to-civil algorithm, no extra crate).
pub fn utc_timestamp(epoch_seconds: u64) -> String {
    let days = (epoch_seconds / 86_400) as i64;
    let seconds = epoch_seconds % 86_400;
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", seconds / 3_600, seconds % 3_600 / 60, seconds % 60)
}

/// One line per attempt in the app log folder. It holds no credentials: the user signs in inside the client.
fn log_attempt(app: &tauri::AppHandle, request: &LaunchRequest, outcome: &LaunchOutcome) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Values are validated (UUID shape, hostname/IP, numeric port) or fixed, so a line cannot be forged.
    let shown = |valid: bool, text: &str| if valid { text.to_string() } else { "-".to_string() };
    let line = format!(
        "{} authorization={} protocol={} target={}:{} status={:?} exit={}\n",
        utc_timestamp(now),
        shown(validate_authorization_id(&request.authorization_id).is_ok(), &request.authorization_id),
        outcome.protocol.chars().filter(char::is_ascii_alphabetic).take(8).collect::<String>(),
        shown(validate_host(&request.host).is_ok(), &request.host),
        request.port,
        outcome.status,
        outcome.exit_code.map_or("-".to_string(), |code| code.to_string()),
    );
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("launch.log")) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Called by the desktop UI right after `POST /access-endpoints/{id}/launch` returned the destination.
#[tauri::command]
pub async fn launch_access(app: tauri::AppHandle, request: LaunchRequest) -> LaunchOutcome {
    let for_launch = request.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || launch_blocking(&for_launch)).await.unwrap_or_else(|error| LaunchOutcome {
        status: Status::SpawnFailed,
        protocol: request.protocol.clone(),
        detail: error.to_string(),
        exit_code: None,
        pid: None,
    });
    log_attempt(&app, &request, &outcome);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ssh_arguments_with_option_terminator() {
        let spec = build_spec("ssh", "srv-a.example.test", 2222).unwrap();
        assert_eq!(spec.client, Client::Ssh);
        assert_eq!(spec.args, ["-p", "2222", "--", "srv-a.example.test"]);
        assert_eq!(build_spec("ssh", "2001:db8::22", 22).unwrap().args, ["-p", "22", "--", "2001:db8::22"]);
    }

    #[test]
    fn builds_rdp_target_with_brackets_only_for_ipv6() {
        assert_eq!(build_spec("rdp", "10.0.0.5", 3389).unwrap().args, ["/v:10.0.0.5:3389"]);
        assert_eq!(build_spec("rdp", "srv_a.example.test", 3390).unwrap().args, ["/v:srv_a.example.test:3390"]);
        assert_eq!(build_spec("rdp", "2001:db8::22", 3390).unwrap().args, ["/v:[2001:db8::22]:3390"]);
    }

    #[test]
    fn rejects_hosts_that_could_act_as_options_or_inject_arguments() {
        for host in [
            "-oProxyCommand=calc", "-v", "host name", "host\"quoted", "host;calc", "host&calc", "host|calc", "host`calc`", "$(calc)",
            "user@host", "host:22", "[::1]", "fe80::1%eth0", "host/path", "host\\share", "", ".", "a..b", "-.example", "host-", "ünï.test",
            "host\nnext", "host\0",
        ] {
            assert!(build_spec("ssh", host, 22).is_err(), "ssh accepted {host:?}");
            assert!(build_spec("rdp", host, 3389).is_err(), "rdp accepted {host:?}");
        }
        assert!(build_spec("ssh", &"a".repeat(64), 22).is_err(), "label over 63 characters");
        assert!(build_spec("ssh", &format!("{}.test", "a".repeat(250)), 22).is_err(), "name over 253 characters");
    }

    #[test]
    fn rejects_unknown_protocols_and_bad_ports() {
        for protocol in ["", "SSH", "Rdp", "telnet", "ssh ", "cmd"] {
            assert!(build_spec(protocol, "host.test", 22).is_err(), "accepted protocol {protocol:?}");
        }
        for port in [0u32, 65_536, 4_294_967_295] {
            assert!(build_spec("ssh", "host.test", port).is_err(), "accepted port {port}");
        }
        assert!(build_spec("ssh", "host.test", 1).is_ok());
        assert!(build_spec("ssh", "host.test", 65_535).is_ok());
    }

    #[test]
    fn authorization_ids_must_look_like_uuids() {
        assert!(validate_authorization_id("44000000-0000-4000-8000-000000000001").is_ok());
        for id in ["", "x", "44000000-0000-4000-8000-00000000000g", "44000000-0000-4000-8000-000000000001\nforged=1"] {
            assert!(validate_authorization_id(id).is_err(), "accepted {id:?}");
        }
    }

    #[test]
    fn invalid_requests_never_start_a_client() {
        let request = LaunchRequest { authorization_id: "44000000-0000-4000-8000-000000000001".into(), protocol: "ssh".into(), host: "-oProxyCommand=calc".into(), port: 22 };
        let outcome = launch_blocking(&request);
        assert_eq!(outcome.status, Status::Invalid);
        assert_eq!(outcome.pid, None);
    }

    #[test]
    fn a_missing_client_is_reported_and_nothing_is_started() {
        // An empty folder stands in for a Windows without OpenSSH Client; PATH is never consulted.
        let empty = std::env::temp_dir().join(format!("lcit-no-clients-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        for (protocol, port) in [("ssh", 22u32), ("rdp", 3389)] {
            let request = LaunchRequest { authorization_id: "44000000-0000-4000-8000-000000000001".into(), protocol: protocol.into(), host: "127.0.0.1".into(), port };
            let outcome = launch_from(&request, &empty);
            assert_eq!(outcome.status, Status::ClientMissing, "{protocol}: {outcome:?}");
            assert_eq!(outcome.pid, None);
        }
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn clients_resolve_under_the_given_system_folder_only() {
        let root = std::path::Path::new(r"D:\fake-windows");
        assert_eq!(client_path(Client::Ssh, root), std::path::Path::new(r"D:\fake-windows\System32\OpenSSH\ssh.exe"));
        assert_eq!(client_path(Client::Rdp, root), std::path::Path::new(r"D:\fake-windows\System32\mstsc.exe"));
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(utc_timestamp(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(utc_timestamp(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    /// Runs the real clients; opens windows, so it is skipped by default: `cargo test -- --ignored`.
    #[cfg(windows)]
    mod real_clients {
        use super::*;

        fn request(protocol: &str, port: u32) -> LaunchRequest {
            LaunchRequest { authorization_id: "44000000-0000-4000-8000-000000000001".into(), protocol: protocol.into(), host: "127.0.0.1".into(), port }
        }

        #[test]
        #[ignore = "opens a console window"]
        fn ssh_to_a_closed_port_exits_early_with_code_255() {
            let outcome = launch_blocking(&request("ssh", 1));
            assert_eq!(outcome.status, Status::ExitedEarly, "{outcome:?}");
            assert_eq!(outcome.exit_code, Some(255));
        }

        #[test]
        #[ignore = "opens the Remote Desktop window"]
        fn mstsc_starts_and_keeps_running() {
            let outcome = launch_blocking(&request("rdp", 1));
            assert_eq!(outcome.status, Status::Started, "{outcome:?}");
            let pid = outcome.pid.expect("pid").to_string();
            let _ = std::process::Command::new("taskkill").args(["/PID", &pid, "/F"]).output();
        }
    }
}

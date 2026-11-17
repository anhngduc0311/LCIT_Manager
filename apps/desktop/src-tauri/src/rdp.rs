//! Native RDP is hosted inside the Tauri window. All COM objects stay on its UI thread.
use crate::launch::{self, LaunchRequest};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
}

impl Bounds {
    fn validate(&self) -> Result<(), String> {
        if self.x < 0
            || self.y < 0
            || self.x > 32_768
            || self.y > 32_768
            || !(1..=16_384).contains(&self.width)
            || !(1..=16_384).contains(&self.height)
        {
            return Err("Kích thước màn hình RDP không hợp lệ".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpStatus {
    pub connected: i32,
    pub reason: i32,
}

fn validate_login(username: &str, domain: &str, password: &str) -> Result<(), String> {
    if username.trim().is_empty()
        || username.len() > 255
        || domain.len() > 255
        || password.len() > 4096
        || username.chars().chain(domain.chars()).any(char::is_control)
        || password.contains('\0')
    {
        return Err("Thông tin đăng nhập RDP không hợp lệ".into());
    }
    Ok(())
}

async fn on_ui<T: Send + 'static>(
    window: &WebviewWindow,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(work());
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|_| "Không nhận được phản hồi RDP".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rdp_open(
    window: WebviewWindow,
    request: LaunchRequest,
    username: String,
    domain: String,
    password: String,
    bounds: Bounds,
) -> Result<String, String> {
    launch::validate_authorization_id(&request.authorization_id)?;
    if request.protocol != "rdp" {
        return Err("Chỉ hỗ trợ điểm truy cập RDP".into());
    }
    launch::build_spec(&request.protocol, &request.host, request.port)?;
    validate_login(&username, &domain, &password)?;
    bounds.validate()?;
    let owner = window.label().to_string();
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let app = window.app_handle().clone();
        on_ui(&window, move || {
            native::open(
                parent, owner, &request, &username, &domain, &password, bounds,
            )?;
            launch::log_attempt(
                &app,
                &request,
                &launch::LaunchOutcome {
                    status: launch::Status::Started,
                    protocol: "rdp".into(),
                    detail: "embedded ActiveX".into(),
                    exit_code: None,
                    pid: None,
                },
            );
            Ok(request.authorization_id)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (owner, request, username, domain, password, bounds);
        Err("RDP tích hợp chỉ hỗ trợ ứng dụng Windows".into())
    }
}

#[tauri::command]
pub async fn rdp_resize(window: WebviewWindow, id: String, bounds: Bounds) -> Result<(), String> {
    bounds.validate()?;
    let owner = window.label().to_string();
    on_ui(&window, move || native::resize(&owner, &id, bounds)).await
}

#[tauri::command]
pub async fn rdp_status(window: WebviewWindow, id: String) -> Result<RdpStatus, String> {
    let owner = window.label().to_string();
    on_ui(&window, move || native::status(&owner, &id)).await
}

#[tauri::command]
pub async fn rdp_close(window: WebviewWindow, id: String) -> Result<(), String> {
    let owner = window.label().to_string();
    on_ui(&window, move || native::close(&owner, &id)).await
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{cell::RefCell, collections::HashMap, ffi::c_void, sync::OnceLock};
    use windows::{
        core::{s, w, IUnknown, Interface, GUID, HRESULT, PCWSTR},
        Win32::{
            Foundation::{HWND, POINT, RECT},
            Graphics::Gdi::{
                CombineRgn, CreateRectRgn, DeleteObject, GetWindowRgn, MapWindowPoints,
                RedrawWindow, SetWindowRgn, HRGN, RDW_ALLCHILDREN, RDW_INVALIDATE, RGN_COPY,
                RGN_DIFF,
            },
            System::{
                Com::{
                    IDispatch, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
                    DISPATCH_PROPERTYPUT, DISPPARAMS,
                },
                LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
                Ole::{IOleInPlaceObject, DISPID_PROPERTYPUT},
                Variant::{VARIANT, VT_DISPATCH},
            },
            UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetClientRect, GetWindow, GetWindowLongW,
                GetWindowRect, IsWindow, SetWindowPos, ShowWindow, GWL_STYLE, GW_CHILD,
                GW_HWNDFIRST, GW_HWNDNEXT, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
                SW_SHOW, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
            },
        },
    };

    type CreateControl = unsafe extern "system" fn(
        PCWSTR,
        HWND,
        *mut c_void,
        *mut *mut c_void,
        *mut *mut c_void,
        *const GUID,
        *mut c_void,
    ) -> HRESULT;
    struct Atl {
        create: CreateControl,
    }
    static ATL: OnceLock<Result<Atl, String>> = OnceLock::new();

    fn atl() -> Result<&'static Atl, String> {
        ATL.get_or_init(|| unsafe {
            let path: Vec<u16> = launch::system_root()
                .join("System32")
                .join("atl.dll")
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // Keep the system library loaded for the lifetime of its hosted controls.
            let module = LoadLibraryExW(PCWSTR(path.as_ptr()), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
                .map_err(|_| "Windows thiếu thành phần ATL để hiển thị RDP".to_string())?;
            let proc = GetProcAddress(module, s!("AtlAxCreateControlEx"))
                .ok_or("Windows không hỗ trợ bộ chứa RDP")?;
            Ok(Atl {
                create: std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateControl>(
                    proc,
                ),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
    }

    fn dispatch(
        control: &IDispatch,
        name: &str,
        flags: DISPATCH_FLAGS,
        mut args: Vec<VARIANT>,
    ) -> Result<VARIANT, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let names = PCWSTR(wide.as_ptr());
        let mut id = 0;
        unsafe { control.GetIDsOfNames(&GUID::zeroed(), &names, 1, 0, &mut id) }
            .map_err(|e| format!("RDP {name}: {}", e.code()))?;
        args.reverse();
        let mut named = DISPID_PROPERTYPUT;
        let params = DISPPARAMS {
            rgvarg: args.as_mut_ptr(),
            cArgs: args.len() as u32,
            rgdispidNamedArgs: if flags == DISPATCH_PROPERTYPUT {
                &mut named
            } else {
                std::ptr::null_mut()
            },
            cNamedArgs: u32::from(flags == DISPATCH_PROPERTYPUT),
        };
        let mut result = VARIANT::default();
        unsafe {
            control.Invoke(
                id,
                &GUID::zeroed(),
                0,
                flags,
                &params,
                Some(&mut result),
                None,
                None,
            )
        }
        .map_err(|e| format!("RDP {name}: {}", e.code()))?;
        Ok(result)
    }

    fn put(control: &IDispatch, name: &str, value: impl Into<VARIANT>) -> Result<(), String> {
        dispatch(control, name, DISPATCH_PROPERTYPUT, vec![value.into()]).map(|_| ())
    }
    fn get(control: &IDispatch, name: &str) -> Result<VARIANT, String> {
        dispatch(control, name, DISPATCH_PROPERTYGET, vec![])
    }
    fn object(control: &IDispatch, name: &str) -> Result<IDispatch, String> {
        let value = get(control, name)?;
        if value.vt() != VT_DISPATCH {
            return Err(format!("RDP {name}: không phải đối tượng COM"));
        }
        unsafe {
            value
                .Anonymous
                .Anonymous
                .Anonymous
                .pdispVal
                .as_ref()
                .cloned()
                .ok_or_else(|| format!("RDP {name}: không có dữ liệu"))
        }
    }
    fn number(control: &IDispatch, name: &str) -> Result<i32, String> {
        i32::try_from(&get(control, name)?)
            .map_err(|_| format!("RDP {name}: trạng thái không hợp lệ"))
    }

    struct SurfaceClip {
        window: HWND,
        original: Option<HRGN>,
    }
    impl Drop for SurfaceClip {
        fn drop(&mut self) {
            unsafe {
                let original = self.original.take();
                if !IsWindow(Some(self.window)).as_bool()
                    || SetWindowRgn(self.window, original, true) == 0
                {
                    if let Some(region) = original {
                        let _ = DeleteObject(region.into());
                    }
                }
            }
        }
    }

    struct Session {
        owner: String,
        host: HWND,
        parent: HWND,
        control: IDispatch,
        bounds: RefCell<Option<Bounds>>,
        clips: RefCell<Vec<SurfaceClip>>,
    }
    impl Drop for Session {
        fn drop(&mut self) {
            let _ = dispatch(&self.control, "Disconnect", DISPATCH_METHOD, vec![]);
            self.clips.borrow_mut().clear();
            unsafe {
                let _ = DestroyWindow(self.host);
            }
        }
    }
    thread_local! { static SESSIONS: RefCell<HashMap<String, Session>> = RefCell::new(HashMap::new()); }

    fn create(parent: HWND) -> Result<Session, String> {
        let host = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                640,
                480,
                Some(parent),
                None,
                None,
                None,
            )
        }
        .map_err(|e| format!("Không tạo được khung RDP: {}", e.code()))?;
        let create = (|| {
            let mut raw = std::ptr::null_mut();
            let class = w!("{A0C63C30-F08D-4AB4-907C-34905D770C7D}");
            unsafe {
                (atl()?.create)(
                    class,
                    host,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut raw,
                    &GUID::zeroed(),
                    std::ptr::null_mut(),
                )
                .ok()
            }
            .map_err(|e| format!("Không nạp được Remote Desktop của Windows: {}", e.code()))?;
            if raw.is_null() {
                return Err("Windows không cung cấp thành phần RDP".into());
            }
            let unknown = unsafe { IUnknown::from_raw(raw) };
            let control = unknown
                .cast::<IDispatch>()
                .map_err(|e| format!("RDP COM: {}", e.code()))?;
            Ok(Session {
                owner: String::new(),
                host,
                parent,
                control,
                bounds: RefCell::new(None),
                clips: RefCell::new(Vec::new()),
            })
        })();
        if create.is_err() {
            unsafe {
                let _ = DestroyWindow(host);
            }
        }
        create
    }

    fn clip_webview(session: &Session, viewport: &RECT) -> Result<(), String> {
        let mut clips = session.clips.borrow_mut();
        let mut sibling = unsafe { GetWindow(session.parent, GW_CHILD) }.ok();
        while let Some(window) = sibling {
            sibling = unsafe { GetWindow(window, GW_HWNDNEXT) }.ok();
            if window == session.host {
                continue;
            }
            let mut rect = RECT::default();
            unsafe { GetWindowRect(window, &mut rect) }.map_err(|e| e.to_string())?;
            if !clips.iter().any(|clip| clip.window == window) {
                let saved = unsafe { CreateRectRgn(0, 0, 0, 0) };
                if saved.is_invalid() {
                    return Err("Không tạo được vùng hiển thị RDP".into());
                }
                let original = if unsafe { GetWindowRgn(window, saved) }.0 != 0 {
                    Some(saved)
                } else {
                    unsafe {
                        let _ = DeleteObject(saved.into());
                    }
                    None
                };
                clips.push(SurfaceClip { window, original });
            }
            let clip = clips.iter().find(|clip| clip.window == window).unwrap();
            let mut origin = [POINT {
                x: rect.left,
                y: rect.top,
            }];
            unsafe {
                MapWindowPoints(None, Some(session.parent), &mut origin);
            }
            let region =
                unsafe { CreateRectRgn(0, 0, rect.right - rect.left, rect.bottom - rect.top) };
            let hole = unsafe {
                CreateRectRgn(
                    viewport.left - origin[0].x,
                    viewport.top - origin[0].y,
                    viewport.right - origin[0].x,
                    viewport.bottom - origin[0].y,
                )
            };
            if region.is_invalid() || hole.is_invalid() {
                unsafe {
                    let _ = DeleteObject(region.into());
                    let _ = DeleteObject(hole.into());
                }
                return Err("Không tạo được vùng hiển thị RDP".into());
            }
            let outcome = unsafe {
                if let Some(original) = clip.original {
                    CombineRgn(Some(region), Some(original), None, RGN_COPY);
                }
                let result = CombineRgn(Some(region), Some(region), Some(hole), RGN_DIFF);
                let _ = DeleteObject(hole.into());
                if result.0 == 0 {
                    0
                } else {
                    SetWindowRgn(window, Some(region), true)
                }
            };
            if outcome == 0 {
                unsafe {
                    let _ = DeleteObject(region.into());
                }
                return Err("Không tách được vùng vẽ RDP khỏi giao diện".into());
            }
            // Windows now owns the region. The saved original is restored on hide/close.
        }
        Ok(())
    }

    fn position(session: &Session, bounds: Bounds) -> Result<(), String> {
        *session.bounds.borrow_mut() = Some(bounds.clone());
        let mut client = RECT::default();
        unsafe { GetClientRect(session.parent, &mut client) }.map_err(|e| e.to_string())?;
        let width = bounds.width.min((client.right - bounds.x).max(0));
        let height = bounds.height.min((client.bottom - bounds.y).max(0));
        if !bounds.visible || width <= 0 || height <= 0 {
            session.clips.borrow_mut().clear();
            unsafe {
                let _ = ShowWindow(session.host, SW_HIDE);
            }
            return Ok(());
        }
        unsafe {
            SetWindowPos(
                session.host,
                Some(HWND_TOP),
                bounds.x,
                bounds.y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        }
        .map_err(|e| e.to_string())?;
        unsafe {
            let _ = ShowWindow(session.host, SW_SHOW);
        }
        // Keep the ActiveX display rectangle in sync even if WebView2 changes
        // sibling order or ATL does not receive a fresh WM_SIZE.
        let rect = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        let inplace = session
            .control
            .cast::<IOleInPlaceObject>()
            .map_err(|e| e.to_string())?;
        unsafe { inplace.SetObjectRects(&rect, &rect) }.map_err(|e| e.to_string())?;
        clip_webview(
            session,
            &RECT {
                left: bounds.x,
                top: bounds.y,
                right: bounds.x + width,
                bottom: bounds.y + height,
            },
        )?;
        unsafe {
            let _ = RedrawWindow(
                Some(session.host),
                None,
                None,
                RDW_INVALIDATE | RDW_ALLCHILDREN,
            );
        }
        Ok(())
    }

    pub(super) fn open(
        parent: usize,
        owner: String,
        request: &LaunchRequest,
        username: &str,
        domain: &str,
        password: &str,
        bounds: Bounds,
    ) -> Result<(), String> {
        SESSIONS.with(|all| {
            let mut all = all.borrow_mut();
            if all.values().any(|s| s.owner == owner) {
                return Err("Cửa sổ này đã có phiên RDP. Hãy đóng phiên cũ.".into());
            }
            let mut session = create(HWND(parent as *mut c_void))?;
            session.owner = owner;
            put(&session.control, "Server", request.host.as_str())?;
            put(&session.control, "UserName", username)?;
            put(&session.control, "Domain", domain)?;
            put(
                &session.control,
                "DesktopWidth",
                bounds.width.clamp(640, 7680),
            )?;
            put(
                &session.control,
                "DesktopHeight",
                bounds.height.clamp(480, 4320),
            )?;
            put(&session.control, "ColorDepth", 32i32)?;
            let advanced = object(&session.control, "AdvancedSettings9")?;
            put(&advanced, "RDPPort", request.port as i32)?;
            put(&advanced, "EnableCredSspSupport", true)?;
            // Windows asks the user about certificate failures; never silently accept them.
            put(&advanced, "AuthenticationLevel", 2i32)?;
            put(&advanced, "SmartSizing", true)?;
            put(&advanced, "RedirectClipboard", false)?;
            put(&advanced, "RedirectDrives", false)?;
            put(&advanced, "RedirectPrinters", false)?;
            if !password.is_empty() {
                put(&advanced, "ClearTextPassword", password)?;
            }
            position(&session, bounds)?;
            dispatch(&session.control, "Connect", DISPATCH_METHOD, vec![])?;
            all.insert(request.authorization_id.clone(), session);
            Ok(())
        })
    }

    fn with<T>(
        owner: &str,
        id: &str,
        action: impl FnOnce(&Session) -> Result<T, String>,
    ) -> Result<T, String> {
        SESSIONS.with(|all| {
            let all = all.borrow();
            let session = all
                .get(id)
                .filter(|s| s.owner == owner)
                .ok_or("Phiên RDP đã đóng")?;
            action(session)
        })
    }
    pub(super) fn resize(owner: &str, id: &str, bounds: Bounds) -> Result<(), String> {
        with(owner, id, |s| position(s, bounds))
    }
    pub(super) fn status(owner: &str, id: &str) -> Result<RdpStatus, String> {
        with(owner, id, |s| {
            // WebView2 may promote its HWND after focus/navigation/render changes.
            // Restore native sibling order without activating the OS window or
            // stealing keyboard focus. Geometry-only updates miss this case.
            let bounds = s.bounds.borrow().clone();
            if let Some(bounds) = bounds {
                let above_webview = unsafe { GetWindow(s.host, GW_HWNDFIRST) }.ok() == Some(s.host);
                let shown = unsafe { GetWindowLongW(s.host, GWL_STYLE) } as u32 & WS_VISIBLE.0 != 0;
                if bounds.visible && (!above_webview || !shown) {
                    position(s, bounds)?;
                }
            }
            Ok(RdpStatus {
                connected: number(&s.control, "Connected")?,
                reason: number(&s.control, "ExtendedDisconnectReason").unwrap_or(0),
            })
        })
    }
    pub(super) fn close(owner: &str, id: &str) -> Result<(), String> {
        SESSIONS.with(|all| {
            let removed = {
                let mut all = all.borrow_mut();
                if all.get(id).is_some_and(|s| s.owner == owner) {
                    all.remove(id)
                } else {
                    None
                }
            };
            drop(removed);
        });
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::WindowsAndMessaging::IsWindow,
        };
        #[test]
        fn rdp_control_loads_and_accepts_secure_configuration() {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            }
            let parent = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("RDP test"),
                    Default::default(),
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            {
                let mut session = create(parent).unwrap();
                session.owner = "main".into();
                put(&session.control, "Server", "127.0.0.1").unwrap();
                put(&session.control, "UserName", "test-user").unwrap();
                let settings = object(&session.control, "AdvancedSettings9").unwrap();
                put(&settings, "RDPPort", 3390i32).unwrap();
                put(&settings, "EnableCredSspSupport", true).unwrap();
                put(&settings, "AuthenticationLevel", 2i32).unwrap();
                put(&settings, "SmartSizing", true).unwrap();
                put(&settings, "RedirectClipboard", false).unwrap();
                put(&settings, "RedirectDrives", false).unwrap();
                put(&settings, "RedirectPrinters", false).unwrap();
                put(&settings, "ClearTextPassword", "test-password").unwrap();
                assert_eq!(number(&settings, "RDPPort").unwrap(), 3390);
                assert_eq!(number(&session.control, "Connected").unwrap(), 0);
                position(
                    &session,
                    Bounds {
                        x: 0,
                        y: 0,
                        width: 640,
                        height: 480,
                        visible: false,
                    },
                )
                .unwrap();
                let host = session.host;
                SESSIONS.with(|all| all.borrow_mut().insert("test-session".into(), session));
                assert!(status("other-window", "test-session").is_err());
                close("other-window", "test-session").unwrap();
                assert_eq!(status("main", "test-session").unwrap().connected, 0);
                assert!(unsafe { IsWindow(Some(host)) }.as_bool());
                close("main", "test-session").unwrap();
                assert!(status("main", "test-session").is_err());
                assert!(!unsafe { IsWindow(Some(host)) }.as_bool());
            }
            unsafe {
                DestroyWindow(parent).unwrap();
                CoUninitialize();
            }
        }

        #[test]
        fn rdp_view_has_a_visible_native_child_filling_the_host() {
            use windows::Win32::{
                System::Ole::IOleInPlaceObject,
                UI::WindowsAndMessaging::{
                    GetWindow, GetWindowLongW, GetWindowRect, GWL_STYLE, GW_HWNDFIRST, WS_VISIBLE,
                },
            };
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            }
            let parent = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("RDP layout test"),
                    Default::default(),
                    0,
                    0,
                    1000,
                    800,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            // A sibling stands in for the full-window WebView2 surface.
            let webview = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("WebView test"),
                    WS_CHILD | WS_VISIBLE,
                    0,
                    0,
                    1000,
                    800,
                    Some(parent),
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            {
                let mut session = create(parent).unwrap();
                session.owner = "render-test".into();
                for (width, height) in [(800, 500), (640, 400)] {
                    position(
                        &session,
                        Bounds {
                            x: 10,
                            y: 60,
                            width,
                            height,
                            visible: true,
                        },
                    )
                    .unwrap();
                    let inplace = session.control.cast::<IOleInPlaceObject>().unwrap();
                    let child =
                        unsafe { inplace.GetWindow() }.expect("RDP must be activated in place");
                    let mut rect = RECT::default();
                    unsafe {
                        GetClientRect(child, &mut rect).unwrap();
                    }
                    assert_eq!(
                        (rect.right, rect.bottom),
                        (width, height),
                        "RDP child must match the viewport"
                    );
                    assert_ne!(
                        unsafe { GetWindowLongW(child, GWL_STYLE) } as u32 & WS_VISIBLE.0,
                        0,
                        "RDP child is hidden"
                    );
                    assert_eq!(
                        unsafe { GetWindow(session.host, GW_HWNDFIRST).unwrap() },
                        session.host,
                        "RDP must appear above WebView2"
                    );
                    let mut host_rect = RECT::default();
                    unsafe {
                        GetWindowRect(session.host, &mut host_rect).unwrap();
                    }
                    assert_eq!(
                        (
                            host_rect.right - host_rect.left,
                            host_rect.bottom - host_rect.top
                        ),
                        (width, height)
                    );
                    // The web renderer must have a real HWND-region cutout;
                    // z-order alone does not isolate its composited graphics surface.
                    let web_region = unsafe { CreateRectRgn(0, 0, 0, 0) };
                    assert_ne!(unsafe { GetWindowRgn(webview, web_region) }.0, 0);
                    assert!(!unsafe {
                        windows::Win32::Graphics::Gdi::PtInRegion(web_region, 20, 80)
                    }
                    .as_bool());
                    assert!(
                        unsafe { windows::Win32::Graphics::Gdi::PtInRegion(web_region, 20, 20) }
                            .as_bool(),
                        "Toolbar must remain visible"
                    );
                    unsafe {
                        let _ = DeleteObject(web_region.into());
                    }
                }
                let host = session.host;
                SESSIONS.with(|all| all.borrow_mut().insert("render-session".into(), session));
                // Reproduce WebView2 promoting itself and hiding/occluding the native sibling.
                unsafe {
                    SetWindowPos(
                        webview,
                        Some(HWND_TOP),
                        0,
                        0,
                        1000,
                        800,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    )
                    .unwrap();
                    let _ = ShowWindow(host, SW_HIDE);
                }
                assert_ne!(unsafe { GetWindow(host, GW_HWNDFIRST).unwrap() }, host);
                assert_eq!(
                    unsafe { GetWindowLongW(host, GWL_STYLE) } as u32 & WS_VISIBLE.0,
                    0
                );
                status("render-test", "render-session").unwrap();
                assert_eq!(unsafe { GetWindow(host, GW_HWNDFIRST).unwrap() }, host);
                assert_ne!(
                    unsafe { GetWindowLongW(host, GWL_STYLE) } as u32 & WS_VISIBLE.0,
                    0
                );
                resize(
                    "render-test",
                    "render-session",
                    Bounds {
                        x: 10,
                        y: 60,
                        width: 640,
                        height: 400,
                        visible: false,
                    },
                )
                .unwrap();
                status("render-test", "render-session").unwrap();
                assert_eq!(
                    unsafe { GetWindowLongW(host, GWL_STYLE) } as u32 & WS_VISIBLE.0,
                    0,
                    "Intentionally hidden view must stay hidden"
                );
                let restored = unsafe { CreateRectRgn(0, 0, 0, 0) };
                assert_eq!(
                    unsafe { GetWindowRgn(webview, restored) }.0,
                    0,
                    "Closing or hiding RDP must restore the full web interface"
                );
                unsafe {
                    let _ = DeleteObject(restored.into());
                }
                close("render-test", "render-session").unwrap();
            }
            unsafe {
                DestroyWindow(webview).unwrap();
                DestroyWindow(parent).unwrap();
                CoUninitialize();
            }
        }

        #[test]
        fn rdp_connect_uses_the_saved_destination_and_closes_its_host() {
            use std::{
                io::Read,
                net::TcpListener,
                sync::mpsc,
                time::{Duration, Instant},
            };
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
            };
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let (sent, received) = mpsc::channel();
            let (release, hold) = mpsc::channel();
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut sockets = Vec::new();
                while Instant::now() < deadline {
                    while let Ok((socket, _)) = listener.accept() {
                        socket.set_nonblocking(true).unwrap();
                        sockets.push(socket);
                    }
                    // Probe sockets must not block the actual transport socket.
                    for socket in &mut sockets {
                        let mut bytes = [0u8; 512];
                        let count = socket.read(&mut bytes).unwrap_or(0);
                        if count == 0 {
                            continue;
                        }
                        let _ = sent.send(bytes[..count].to_vec());
                        let _ = hold.recv_timeout(Duration::from_secs(5));
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            }
            let parent = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("RDP transport test"),
                    Default::default(),
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            let request = LaunchRequest {
                authorization_id: "44000000-0000-4000-8000-000000000001".into(),
                protocol: "rdp".into(),
                host: "127.0.0.1".into(),
                port: u32::from(port),
            };
            open(
                parent.0 as usize,
                "transport-test".into(),
                &request,
                "test-user",
                "",
                "",
                Bounds {
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600,
                    visible: false,
                },
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut packet = Vec::new();
            while Instant::now() < deadline {
                if let Ok(bytes) = received.try_recv() {
                    packet = bytes;
                    break;
                }
                let mut message = MSG::default();
                unsafe {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            close("transport-test", &request.authorization_id).unwrap();
            let _ = release.send(());
            server.join().unwrap();
            unsafe {
                DestroyWindow(parent).unwrap();
                CoUninitialize();
            }
            assert!(
                packet.len() >= 7,
                "RDP did not send its connection request to the saved port"
            );
            assert_eq!(
                &packet[..2],
                &[3, 0],
                "Expected an RDP TPKT connection request"
            );
        }
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn resize(_: &str, _: &str, _: Bounds) -> Result<(), String> {
        Err("Chỉ hỗ trợ Windows".into())
    }
    pub fn status(_: &str, _: &str) -> Result<RdpStatus, String> {
        Err("Chỉ hỗ trợ Windows".into())
    }
    pub fn close(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_and_bounds_are_validated() {
        assert!(validate_login("user@example.test", "", "p a s s").is_ok());
        assert!(validate_login("", "", "password").is_err());
        assert!(validate_login("user\nname", "", "password").is_err());
        assert!(validate_login("user", "domain", "pass\0word").is_err());
        assert!(Bounds {
            x: -1,
            y: 0,
            width: 800,
            height: 600,
            visible: true
        }
        .validate()
        .is_err());
        assert!(Bounds {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            visible: true
        }
        .validate()
        .is_ok());
    }
}

use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    App, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const LOOPBACK_HOST: &str = "127.0.0.1";
const BRIDGE_START_TIMEOUT: Duration = Duration::from_secs(20);
const BRIDGE_STOP_TIMEOUT: Duration = Duration::from_secs(8);
const QA_TITLE_PREFIX: &str = "__AEONQUILL_QA__";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timeline {
    tauri_ready_ms: Option<u128>,
    bridge_spawned_ms: Option<u128>,
    bridge_ready_ms: Option<u128>,
    window_loaded_ms: Option<u128>,
    renderer_probed_ms: Option<u128>,
    shutdown_finished_ms: Option<u128>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererProbe {
    tauri_global_type: Option<String>,
    process_type: Option<String>,
    require_type: Option<String>,
    document_ready_state: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShutdownReport {
    requested: bool,
    exited: bool,
    exit_code: Option<i32>,
    forced: bool,
    port_closed: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopReport {
    schema_version: u8,
    status: String,
    shell: String,
    packaged: bool,
    platform: String,
    arch: String,
    timeline: Timeline,
    renderer_probe: RendererProbe,
    bridge_pid: Option<u32>,
    bridge_port: Option<u16>,
    bridge_stderr_tail: String,
    shutdown: Option<ShutdownReport>,
    error: Option<String>,
}

struct DesktopRuntime {
    started_at: Instant,
    qa_mode: bool,
    child: Mutex<Option<CommandChild>>,
    terminated: (Mutex<Option<i32>>, Condvar),
    report: Mutex<DesktopReport>,
    runtime_directory: Mutex<Option<PathBuf>>,
    qa_report_path: Mutex<Option<PathBuf>>,
}

impl DesktopRuntime {
    fn new() -> Self {
        let qa_mode = std::env::var("AEONQUILL_DESKTOP_QA")
            .or_else(|_| std::env::var("MIAOHUI_DESKTOP_QA"))
            .as_deref()
            == Ok("1");
        Self {
            started_at: Instant::now(),
            qa_mode,
            child: Mutex::new(None),
            terminated: (Mutex::new(None), Condvar::new()),
            report: Mutex::new(DesktopReport {
                schema_version: 1,
                status: "starting".into(),
                shell: "tauri".into(),
                packaged: !cfg!(debug_assertions),
                platform: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                ..DesktopReport::default()
            }),
            runtime_directory: Mutex::new(None),
            qa_report_path: Mutex::new(None),
        }
    }

    fn elapsed_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    fn record_stderr(&self, line: &[u8]) {
        let text = String::from_utf8_lossy(line);
        let mut report = self.report.lock().expect("desktop report lock poisoned");
        report.bridge_stderr_tail.push_str(&text);
        report.bridge_stderr_tail.push('\n');
        if report.bridge_stderr_tail.len() > 4_000 {
            let mut keep_from = report.bridge_stderr_tail.len() - 4_000;
            while !report.bridge_stderr_tail.is_char_boundary(keep_from) {
                keep_from += 1;
            }
            report.bridge_stderr_tail = report.bridge_stderr_tail[keep_from..].to_string();
        }
    }

    fn record_renderer_probe(&self, title: &str) -> bool {
        let Some(raw) = title.strip_prefix(QA_TITLE_PREFIX) else {
            return false;
        };
        let values: Vec<_> = raw.split('|').collect();
        if values.len() != 4 {
            return false;
        }
        let mut report = self.report.lock().expect("desktop report lock poisoned");
        report.renderer_probe = RendererProbe {
            tauri_global_type: Some(values[0].into()),
            process_type: Some(values[1].into()),
            require_type: Some(values[2].into()),
            document_ready_state: Some(values[3].into()),
        };
        report.timeline.renderer_probed_ms = Some(self.elapsed_ms());
        true
    }

    fn shutdown_bridge(&self) -> ShutdownReport {
        let requested = self
            .child
            .lock()
            .expect("bridge child lock poisoned")
            .as_mut()
            .is_some_and(|child| child.write(b"shutdown\n").is_ok());

        let deadline = Instant::now() + BRIDGE_STOP_TIMEOUT;
        let (terminated_lock, terminated_signal) = &self.terminated;
        let mut exit_code = terminated_lock
            .lock()
            .expect("bridge termination lock poisoned");
        while exit_code.is_none() && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = terminated_signal
                .wait_timeout(exit_code, remaining)
                .expect("bridge termination lock poisoned");
            exit_code = result.0;
            if result.1.timed_out() {
                break;
            }
        }
        let mut forced = false;
        if exit_code.is_none() {
            if let Some(child) = self
                .child
                .lock()
                .expect("bridge child lock poisoned")
                .take()
            {
                forced = child.kill().is_ok();
            }
        }
        let final_code = *exit_code;
        drop(exit_code);
        let port = self
            .report
            .lock()
            .expect("desktop report lock poisoned")
            .bridge_port;
        let port_closed =
            port.is_none_or(|value| wait_for_port_closed(value, Duration::from_secs(3)));
        ShutdownReport {
            requested,
            exited: final_code.is_some(),
            exit_code: final_code,
            forced,
            port_closed,
        }
    }

    fn write_qa_report(
        &self,
        shutdown: ShutdownReport,
        error: Option<String>,
    ) -> Result<(), String> {
        if !self.qa_mode {
            return Ok(());
        }
        let runtime_directory = self
            .runtime_directory
            .lock()
            .map_err(|_| "runtime directory lock poisoned")?
            .clone()
            .ok_or("runtime directory was not initialized")?;
        let report_path = self
            .qa_report_path
            .lock()
            .map_err(|_| "QA report path lock poisoned")?
            .clone()
            .ok_or("QA report path was not initialized")?;
        if report_path.strip_prefix(&runtime_directory).is_err() || report_path == runtime_directory
        {
            return Err("Tauri QA report must stay inside the isolated runtime directory".into());
        }

        let mut report = self
            .report
            .lock()
            .map_err(|_| "desktop report lock poisoned")?;
        report.timeline.shutdown_finished_ms = Some(self.elapsed_ms());
        report.status = if error.is_none()
            && shutdown.exited
            && shutdown.exit_code == Some(0)
            && shutdown.port_closed
            && !shutdown.forced
        {
            "passed".into()
        } else {
            "failed".into()
        };
        report.shutdown = Some(shutdown);
        report.error = error;
        let bytes = serde_json::to_vec_pretty(&*report).map_err(|error| error.to_string())?;
        drop(report);

        if let Some(parent) = report_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary_path = report_path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temporary_path, bytes).map_err(|error| error.to_string())?;
        fs::rename(temporary_path, report_path).map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

fn bridge_health_ready(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), Duration::from_millis(400))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .is_err()
    {
        return false;
    }
    response.contains(" 200 ")
        && response.contains("\"ok\":true")
        && response.contains("\"service\":\"miaohui-local-bridge\"")
}

fn wait_for_bridge_ready(runtime: &DesktopRuntime, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + BRIDGE_START_TIMEOUT;
    while Instant::now() < deadline {
        if bridge_health_ready(port) {
            return Ok(());
        }
        if runtime
            .terminated
            .0
            .lock()
            .map_err(|_| "bridge termination lock poisoned")?
            .is_some()
        {
            return Err("Node sidecar exited before the local bridge became ready".into());
        }
        thread::sleep(Duration::from_millis(120));
    }
    Err("Local bridge did not become ready within 20 seconds".into())
}

fn wait_for_port_closed(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address.into(), Duration::from_millis(200)).is_err() {
            return true;
        }
        thread::sleep(Duration::from_millis(80));
    }
    false
}

fn qa_auto_close_delay() -> Duration {
    let milliseconds = std::env::var("AEONQUILL_DESKTOP_AUTOCLOSE_MS")
        .or_else(|_| std::env::var("MIAOHUI_DESKTOP_AUTOCLOSE_MS"))
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(600)
        .clamp(250, 12_000);
    Duration::from_millis(milliseconds)
}

fn normalize_env_key(value: &OsStr) -> String {
    value.to_string_lossy().to_ascii_uppercase()
}

fn configured_path(primary_key: &str, legacy_key: Option<&str>, fallback: PathBuf) -> PathBuf {
    std::env::var_os(primary_key)
        .or_else(|| legacy_key.and_then(std::env::var_os))
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

fn safe_child_environment() -> HashMap<OsString, OsString> {
    const SAFE_KEYS: &[&str] = &[
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TZ",
        "USERPROFILE",
        "WINDIR",
    ];
    const SAFE_PREFIXES: &[&str] = &[
        "CUDA_", "HIP_", "KMP_", "NVIDIA_", "OMP_", "PYTORCH_", "ROCM_", "TORCH_", "VK_", "VULKAN_",
    ];
    std::env::vars_os()
        .filter(|(key, _)| {
            let normalized = normalize_env_key(key);
            SAFE_KEYS.contains(&normalized.as_str())
                || SAFE_PREFIXES
                    .iter()
                    .any(|prefix| normalized.starts_with(prefix))
        })
        .collect()
}

fn configured_child_environment(
    runtime_directory: &Path,
    data_directory: &Path,
    cache_directory: &Path,
    log_directory: &Path,
    config_path: &Path,
    port: u16,
) -> HashMap<OsString, OsString> {
    let mut environment = safe_child_environment();
    let forwarded_keys = [
        "AEONQUILL_ALLOWED_ORIGINS",
        "MIAOHUI_ALLOWED_ORIGINS",
        "AEONQUILL_COMFY_POLICY",
        "AEONQUILL_COMFY_IDLE_SECONDS",
        "MIAOHUI_COMFY_POLICY",
        "MIAOHUI_COMFY_IDLE_SECONDS",
        "AEONQUILL_IMAGE_CONCURRENCY",
        "MIAOHUI_IMAGE_CONCURRENCY",
        "COMFY_URL",
        "COMFY_ROOT",
        "COMFY_PYTHON",
        "FFMPEG_PATH",
        "FFPROBE_PATH",
        "AEONQUILL_REMBG_PATH",
        "AEONQUILL_REMBG_MODELS",
        "AEONQUILL_REALESRGAN_PATH",
        "AEONQUILL_REALESRGAN_MODELS",
        "MIAOHUI_REMBG_PATH",
        "MIAOHUI_REMBG_MODELS",
        "MIAOHUI_REALESRGAN_PATH",
        "MIAOHUI_REALESRGAN_MODELS",
    ];
    for key in forwarded_keys {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    environment.insert("AEONQUILL_PORT".into(), port.to_string().into());
    environment.insert("AEONQUILL_HOST".into(), LOOPBACK_HOST.into());
    environment.insert(
        "AEONQUILL_RUNTIME_DIR".into(),
        runtime_directory.as_os_str().into(),
    );
    environment.insert(
        "AEONQUILL_DATA_DIR".into(),
        data_directory.as_os_str().into(),
    );
    environment.insert(
        "AEONQUILL_CACHE_DIR".into(),
        cache_directory.as_os_str().into(),
    );
    environment.insert("AEONQUILL_LOG_DIR".into(), log_directory.as_os_str().into());
    environment.insert("AEONQUILL_CONFIG".into(), config_path.as_os_str().into());
    environment.insert("AEONQUILL_PARENT_CONTROL".into(), "stdio".into());

    // Mirror the original bridge contract until server-side migration is complete.
    environment.insert("MIAOHUI_PORT".into(), port.to_string().into());
    environment.insert("MIAOHUI_HOST".into(), LOOPBACK_HOST.into());
    environment.insert(
        "MIAOHUI_RUNTIME_DIR".into(),
        runtime_directory.as_os_str().into(),
    );
    environment.insert("MIAOHUI_CONFIG".into(), config_path.as_os_str().into());
    environment.insert("MIAOHUI_PARENT_CONTROL".into(), "stdio".into());
    environment
}

fn setup_desktop(
    app: &mut App,
    runtime: &Arc<DesktopRuntime>,
) -> Result<(), Box<dyn std::error::Error>> {
    let default_data_directory = app.path().app_local_data_dir()?;
    let runtime_directory = configured_path(
        "AEONQUILL_RUNTIME_DIR",
        Some("MIAOHUI_RUNTIME_DIR"),
        default_data_directory.join("runtime"),
    );
    let data_directory = configured_path(
        "AEONQUILL_DATA_DIR",
        None,
        default_data_directory.join("data"),
    );
    let cache_directory = configured_path(
        "AEONQUILL_CACHE_DIR",
        None,
        default_data_directory.join("cache"),
    );
    let log_directory = configured_path(
        "AEONQUILL_LOG_DIR",
        None,
        default_data_directory.join("logs"),
    );
    let config_path = configured_path(
        "AEONQUILL_CONFIG",
        Some("MIAOHUI_CONFIG"),
        default_data_directory.join("config").join("local.json"),
    );
    for directory in [
        &runtime_directory,
        &data_directory,
        &cache_directory,
        &log_directory,
    ] {
        fs::create_dir_all(directory)?;
    }
    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)?;
    }
    *runtime
        .runtime_directory
        .lock()
        .map_err(|_| "runtime directory lock poisoned")? = Some(runtime_directory.clone());
    if runtime.qa_mode {
        let report_path = std::env::var_os("AEONQUILL_DESKTOP_REPORT")
            .or_else(|| std::env::var_os("MIAOHUI_DESKTOP_REPORT"))
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_directory.join("tauri-desktop-qa.json"));
        *runtime
            .qa_report_path
            .lock()
            .map_err(|_| "QA report path lock poisoned")? = Some(report_path);
    }
    runtime
        .report
        .lock()
        .map_err(|_| "desktop report lock poisoned")?
        .timeline
        .tauri_ready_ms = Some(runtime.elapsed_ms());

    let port = reserve_loopback_port()?;
    let environment = configured_child_environment(
        &runtime_directory,
        &data_directory,
        &cache_directory,
        &log_directory,
        &config_path,
        port,
    );
    let (mut events, child) = app
        .shell()
        .sidecar("aeonquill-bridge")?
        .env_clear()
        .envs(environment)
        .current_dir(&runtime_directory)
        .spawn()?;
    let pid = child.pid();
    {
        let mut report = runtime
            .report
            .lock()
            .map_err(|_| "desktop report lock poisoned")?;
        report.bridge_pid = Some(pid);
        report.bridge_port = Some(port);
        report.timeline.bridge_spawned_ms = Some(runtime.elapsed_ms());
    }
    *runtime
        .child
        .lock()
        .map_err(|_| "bridge child lock poisoned")? = Some(child);

    let event_runtime = Arc::clone(runtime);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(line) => event_runtime.record_stderr(&line),
                CommandEvent::Error(message) => event_runtime.record_stderr(message.as_bytes()),
                CommandEvent::Terminated(payload) => {
                    let (lock, signal) = &event_runtime.terminated;
                    if let Ok(mut exit_code) = lock.lock() {
                        *exit_code = payload.code;
                        signal.notify_all();
                    }
                }
                CommandEvent::Stdout(_) => {}
                _ => {}
            }
        }
    });

    if let Err(error) = wait_for_bridge_ready(runtime, port) {
        let _ = runtime.shutdown_bridge();
        return Err(error.into());
    }
    runtime
        .report
        .lock()
        .map_err(|_| "desktop report lock poisoned")?
        .timeline
        .bridge_ready_ms = Some(runtime.elapsed_ms());

    let base_url = format!("http://{LOOPBACK_HOST}:{port}");
    let navigation_origin = base_url.clone();
    let title_runtime = Arc::clone(runtime);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(base_url.parse()?))
        .title("光阴砚 AEONQUILL")
        .inner_size(1480.0, 940.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .visible(false)
        .devtools(cfg!(debug_assertions) && !runtime.qa_mode)
        .on_navigation(move |url| url.origin().ascii_serialization() == navigation_origin)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_document_title_changed(move |window, title| {
            if !title_runtime.record_renderer_probe(&title) || !title_runtime.qa_mode {
                return;
            }
            let handle = window.app_handle().clone();
            thread::spawn(move || {
                thread::sleep(qa_auto_close_delay());
                handle.exit(0);
            });
        })
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep Tauri's patchable bundle marker linked into release builds so the
    // updater can distinguish NSIS/MSI/AppImage packages after bundling.
    let _ = tauri::utils::platform::bundle_type();
    let runtime = Arc::new(DesktopRuntime::new());
    let setup_runtime = Arc::clone(&runtime);
    let page_runtime = Arc::clone(&runtime);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| setup_desktop(app, &setup_runtime))
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" || !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            page_runtime
                .report
                .lock()
                .expect("desktop report lock poisoned")
                .timeline
                .window_loaded_ms = Some(page_runtime.elapsed_ms());
            if page_runtime.qa_mode {
                let _ = webview.eval(format!(
                    "document.title = '{}'+[typeof window.__TAURI__,typeof window.process,typeof window.require,document.readyState].join('|')",
                    QA_TITLE_PREFIX
                ));
            } else {
                let _ = webview.window().show();
            }
        })
        .build(tauri::generate_context!())
        .expect("AEONQUILL desktop runtime failed to initialize");

    let exit_code = app.run_return(|_, _| {});
    let shutdown = runtime.shutdown_bridge();
    if let Err(error) = runtime.write_qa_report(shutdown, None) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    std::process::exit(exit_code);
}

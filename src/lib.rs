mod listener;
mod logging;

use crate::listener::{Canceller, listener_with_canceller};
use crate::logging::{Config, setup_log_rotation};
use mtorrent::{app, utils};
use mtorrent_dht as dht;
use mtorrent_utils::{peer_id::PeerId, worker};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::io;
use std::sync::Mutex;
use tauri::Manager;

const UPNP_ENABLED: bool = true;

struct State {
    peer_id: PeerId,
    pwp_runtime_handle: tokio::runtime::Handle,
    storage_runtime_handle: tokio::runtime::Handle,
    dht_cmd_sender: dht::CommandSink,
    active_downloads: Mutex<HashMap<String, Canceller>>,
}

#[tauri::command]
async fn start_download(
    metainfo_uri: String,
    output_dir: String,
    callback: tauri::ipc::Channel<serde_json::Value>,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let (listener, canceller) = listener_with_canceller(callback, log::Level::Debug);
    match state.active_downloads.lock().unwrap().entry(metainfo_uri.clone()) {
        Entry::Occupied(_) => {
            return Err("already in progress".to_owned());
        }
        Entry::Vacant(entry) => {
            entry.insert(canceller);
        }
    }
    let task = tokio::task::spawn_local(app::main::single_torrent(
        state.peer_id,
        metainfo_uri,
        output_dir,
        Some(state.dht_cmd_sender.clone()),
        listener,
        state.pwp_runtime_handle.clone(),
        state.storage_runtime_handle.clone(),
        UPNP_ENABLED,
    ));
    task.await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_download(metainfo_uri: &str, state: tauri::State<'_, State>) {
    state.active_downloads.lock().unwrap().remove(metainfo_uri);
}

#[tauri::command]
fn get_name(metainfo_uri: &str) -> Result<String, ()> {
    utils::startup::get_torrent_name(metainfo_uri).ok_or(())
}

fn run_with_exit_code() -> io::Result<i32> {
    let current_dir = std::env::current_dir()?;

    let (log_sink, mut log_writer) = setup_log_rotation(Config {
        file_path: current_dir.join("mtorrent.log"),
        max_files: 3,
        max_file_size: 10 * 1024 * 1024, // 10 MiB
        buffer_capacity: 32 * 1024,      // 32 KiB
    });

    std::thread::Builder::new()
        .name("logger".to_owned())
        .stack_size(128 * 1024)
        .spawn(move || {
            log_writer.write_logs().inspect_err(|e| eprintln!("Failed to write logs: {e}"))
        })?;

    env_logger::Builder::from_default_env()
        .filter(None, log::LevelFilter::Debug)
        // .filter_module("mtorrent_dht", log::LevelFilter::Info)
        // .filter_module("mtorrent::app", log::LevelFilter::Info)
        // .filter_module("mtorrent_utils", log::LevelFilter::Debug)
        .target(env_logger::Target::Pipe(Box::new(log_sink)))
        .init();

    let main_worker = worker::with_local_runtime(worker::rt::Config {
        name: "app".to_owned(),
        io_enabled: true,
        time_enabled: true,
        ..Default::default()
    })?;
    tauri::async_runtime::set(main_worker.runtime_handle().clone());

    let storage_worker = worker::with_runtime(worker::rt::Config {
        name: "storage".to_owned(),
        io_enabled: false,
        time_enabled: false,
        ..Default::default()
    })?;

    let pwp_worker = worker::with_runtime(worker::rt::Config {
        name: "pwp".to_owned(),
        io_enabled: true,
        time_enabled: true,
        ..Default::default()
    })?;

    let (_dht_worker, dht_cmds) =
        app::dht::launch_node_runtime(6881, None, current_dir, UPNP_ENABLED)?;

    let state = State {
        peer_id: PeerId::generate_new(),
        pwp_runtime_handle: pwp_worker.runtime_handle().clone(),
        storage_runtime_handle: storage_worker.runtime_handle().clone(),
        dht_cmd_sender: dht_cmds,
        active_downloads: Mutex::new(HashMap::new()),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![start_download, stop_download, get_name])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    Ok(app.run_return(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<State>();
            state.active_downloads.lock().unwrap().clear();
            _ = state.dht_cmd_sender.try_send(dht::Command::Shutdown);
        }
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let code = match run_with_exit_code() {
        Ok(code) => code,
        Err(e) => e.raw_os_error().unwrap_or(-1),
    };
    std::process::exit(code)
}

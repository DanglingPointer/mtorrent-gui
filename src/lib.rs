mod listener;
mod logging;

use crate::listener::{Canceller, listener_with_canceller};
use crate::logging::{Config, setup_log_rotation};
use mtorrent::utils::re_exports::mtorrent_dht as dht;
use mtorrent::utils::re_exports::mtorrent_utils::{peer_id::PeerId, worker};
use mtorrent::{app, utils};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::PathBuf;
use std::{env, io, mem, panic};
use tauri::Manager;
use tokio::sync::oneshot;
use tokio::task;

const UPNP_ENABLED: bool = true;

struct DownloadEntry {
    canceller: Canceller,
    join_handle: task::JoinHandle<()>,
}

struct State {
    peer_id: PeerId,
    local_data_dir: PathBuf,
    bind_interface: Option<String>,
    active_downloads: Mutex<HashMap<String, DownloadEntry>>,
    pwp_runtime_handle: tokio::runtime::Handle,
    storage_runtime_handle: tokio::runtime::Handle,
    dht_cmd_sender: dht::CommandSink,
}

async fn shutdown_all_downloads(active_downloads: HashMap<String, DownloadEntry>) {
    log::info!("Shutting down all active downloads");

    // drop all cancellers
    let join_handles = active_downloads.into_values().map(|entry| entry.join_handle);

    // join all handles
    futures_util::future::join_all(join_handles).await;
}

#[tauri::command]
async fn do_download(
    metainfo_uri: String,
    output_dir: String,
    callback: tauri::ipc::Channel<serde_json::Value>,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let (listener, canceller) = listener_with_canceller(callback, log::Level::Debug);
    let (result_tx, result_rx) = oneshot::channel();

    {
        // reserve entry unless it's a duplicate
        let mut active_downloads = state.active_downloads.lock();
        let entry_slot = match active_downloads.entry(metainfo_uri.clone()) {
            Entry::Occupied(_) => {
                return Err("already in progress".to_owned());
            }
            Entry::Vacant(entry) => entry,
        };

        // spawn the download task
        let cfg = app::main::Config {
            local_peer_id: state.peer_id,
            output_dir: output_dir.into(),
            config_dir: state.local_data_dir.clone(),
            use_upnp: UPNP_ENABLED,
            pwp_port: None,
            bind_interface: state.bind_interface.clone(),
            download_strategy: Default::default(),
        };
        let ctx = app::main::Context {
            dht_handle: Some(state.dht_cmd_sender.clone()),
            pwp_runtime: state.pwp_runtime_handle.clone(),
            storage_runtime: state.storage_runtime_handle.clone(),
        };
        let uri = metainfo_uri.clone();

        let join_handle = tokio::task::spawn_local(async move {
            let result = app::main::single_torrent(uri, listener, cfg, ctx).await;
            _ = result_tx.send(result);
        });

        // populate the download entry and unlock the mutex
        entry_slot.insert(DownloadEntry {
            canceller,
            join_handle,
        });
    }

    // wait for download to finish
    let result = result_rx.await;

    // clean up the stale entry
    state.active_downloads.lock().remove(&metainfo_uri);

    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn stop_download(metainfo_uri: &str, state: tauri::State<'_, State>) -> Result<(), String> {
    let Some(DownloadEntry {
        canceller,
        join_handle,
    }) = state.active_downloads.lock().remove(metainfo_uri)
    else {
        return Ok(());
    };

    drop(canceller);
    _ = join_handle.await;
    Ok(())
}

#[tauri::command]
fn get_name(metainfo_uri: &str) -> Result<String, ()> {
    utils::startup::get_torrent_name(metainfo_uri).ok_or(())
}

#[tauri::command]
fn get_cli_arg() -> Option<String> {
    env::args().nth(1)
}

#[cfg(unix)]
fn raise_open_file_limit() {
    // copied from https://github.com/sachesi/rill/commit/e3743916e999bedb69c1d951b5bc2785689e50cb#diff-42cb6807ad74b3e201c5a7ca98b911c5fa08380e942be6e4ac5807f8377f87fcR158

    const OPEN_FILES_CEILING: libc::rlim_t = 1 << 20;

    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };

    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        log::warn!("Could not read the open file limit: {}", io::Error::last_os_error());
        return;
    }

    let wanted = limit.rlim_max.min(OPEN_FILES_CEILING);
    if limit.rlim_cur >= wanted {
        return;
    }

    let previous = limit.rlim_cur;
    limit.rlim_cur = wanted;

    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } == 0 {
        log::info!("Raised the open file limit from {previous} to {wanted}");
    } else {
        log::warn!(
            "Could not raise the open file limit from {previous}: {}",
            io::Error::last_os_error()
        );
    }
}

fn run_with_exit_code() -> io::Result<i32> {
    // unsafe { env::set_var("MTORRENT_PWP_MODE", "UTP_ONLY") }

    let local_data_dir = match dirs_next::data_local_dir()
        .or_else(dirs_next::data_dir)
        .or_else(dirs_next::config_dir)
    {
        Some(dir) => dir,
        None => env::current_dir()?,
    };
    let local_data_dir = local_data_dir.join(env!("CARGO_PKG_NAME"));
    println!("Log directory: {}", local_data_dir.display());

    let (log_sink, mut log_writer) = setup_log_rotation(Config {
        file_path: local_data_dir.join("mtorrent.log"),
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

    env_logger::Builder::from_env("MTORRENT_LOG")
        .filter_level(log::LevelFilter::Debug)
        // .filter_module("mtorrent_dht", log::LevelFilter::Info)
        // .filter_module("mtorrent::app", log::LevelFilter::Info)
        // .filter_module("mtorrent_utils", log::LevelFilter::Debug)
        .target(env_logger::Target::Pipe(Box::new(log_sink)))
        .init();

    panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        eprintln!("Thread {thread_name} {info}");
        log::error!("Thread {thread_name} {info}");
    }));

    #[cfg(unix)]
    raise_open_file_limit();

    let interface = env::var("MTORRENT_NET_IF").ok();

    let main_worker = worker::with_local_runtime(worker::rt::Config {
        name: "app".to_owned(),
        io_enabled: false,
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

    let pwp_worker = worker::with_local_runtime(worker::rt::Config {
        name: "pwp".to_owned(),
        io_enabled: true,
        time_enabled: true,
        max_blocking_threads: 32,
        ..Default::default()
    })?;

    let (_dht_worker, dht_cmds) = app::dht::launch_dht_node_runtime(app::dht::Config {
        local_port: 6881,
        max_concurrent_queries: None,
        config_dir: local_data_dir.clone(),
        use_upnp: UPNP_ENABLED,
        bootstrap_nodes_override: None,
        bind_interface: interface.clone(),
        query_timeout: None,
    })?;

    let state = State {
        peer_id: PeerId::generate_new(),
        local_data_dir,
        bind_interface: interface,
        active_downloads: Mutex::new(HashMap::new()),
        pwp_runtime_handle: pwp_worker.runtime_handle().clone(),
        storage_runtime_handle: storage_worker.runtime_handle().clone(),
        dht_cmd_sender: dht_cmds,
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![do_download, stop_download, get_name, get_cli_arg])
        .build(tauri::generate_context!())
        .map_err(io::Error::other)?;

    Ok(app.run_return(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<State>();
            let active_downloads = mem::take(&mut *state.active_downloads.lock());
            main_worker.runtime_handle().block_on(shutdown_all_downloads(active_downloads));
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

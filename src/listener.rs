use mtorrent::utils::listener::{StateListener, StateSnapshot};
use std::time::Duration;

struct DumpSnapshot {
    level: log::Level,
    ticks: usize,
}

pub struct Listener {
    callback: tauri::ipc::Channel<serde_json::Value>,
    dump_cfg: Option<DumpSnapshot>,
}

impl Listener {
    pub fn new(callback: tauri::ipc::Channel<serde_json::Value>, dump_level: log::Level) -> Self {
        Self {
            callback,
            dump_cfg: log::log_enabled!(dump_level).then_some(DumpSnapshot {
                level: dump_level,
                ticks: 0,
            }),
        }
    }
}

impl StateListener for Listener {
    const INTERVAL: Duration = Duration::from_secs(1);

    fn on_snapshot(&mut self, mut snapshot: StateSnapshot<'_>) {
        if let Some(dump) = &mut self.dump_cfg {
            // dump snapshot every 10s
            dump.ticks = dump.ticks.wrapping_add(1);
            if dump.ticks.is_multiple_of(10) {
                log::log!(dump.level, "{snapshot}");
            }
        }

        snapshot.pieces.bitfield.clear(); // makes serialisation faster
        let json_value = serde_json::to_value(&snapshot)
            .unwrap_or_else(|e| serde_json::Value::String(e.to_string()));
        if let Err(e) = self.callback.send(json_value) {
            log::error!("Failed to send snapshot to GUI: {e}");
        }
    }
}

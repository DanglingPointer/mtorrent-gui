use mtorrent::utils::listener::{StateListener, StateSnapshot};
use std::{ops::ControlFlow, sync::Arc, time::Duration};

struct DumpSnapshot {
    level: log::Level,
    ticks: usize,
}

pub struct Listener {
    callback: tauri::ipc::Channel<serde_json::Value>,
    token: Arc<()>,
    dump_cfg: Option<DumpSnapshot>,
}

pub struct Canceller {
    token: Arc<()>,
}

pub fn listener_with_canceller(
    callback: tauri::ipc::Channel<serde_json::Value>,
    dump_level: log::Level,
) -> (Listener, Canceller) {
    let canceller = Canceller {
        token: Arc::new(()),
    };
    let listener = Listener {
        callback,
        token: canceller.token.clone(),
        dump_cfg: log::log_enabled!(dump_level).then_some(DumpSnapshot {
            level: dump_level,
            ticks: 0,
        }),
    };
    (listener, canceller)
}

impl StateListener for Listener {
    const INTERVAL: Duration = Duration::from_secs(1);

    fn on_snapshot(&mut self, snapshot: StateSnapshot<'_>) -> ControlFlow<()> {
        if Arc::strong_count(&self.token) == 1 {
            ControlFlow::Break(())
        } else {
            if let Some(dump) = &mut self.dump_cfg {
                // dump snapshot every 10s
                dump.ticks = dump.ticks.wrapping_add(1);
                if dump.ticks.is_multiple_of(10) {
                    log::log!(dump.level, "{snapshot}");
                }
            }
            let json_value = serde_json::to_value(&snapshot)
                .unwrap_or_else(|e| serde_json::Value::String(e.to_string()));
            match self.callback.send(json_value) {
                Ok(_) => ControlFlow::Continue(()),
                Err(_) => ControlFlow::Break(()),
            }
        }
    }
}

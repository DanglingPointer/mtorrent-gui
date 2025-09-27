use file_rotate::compression::Compression;
use file_rotate::suffix::AppendCount;
use file_rotate::{ContentLimit, FileRotate};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, LockResult, Mutex, MutexGuard};
use std::{io, mem};

trait IntoGuard<'a, T> {
    fn into_guard(self) -> MutexGuard<'a, T>;
}

impl<'a, T: 'a> IntoGuard<'a, T> for LockResult<MutexGuard<'a, T>> {
    fn into_guard(self) -> MutexGuard<'a, T> {
        match self {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

struct State {
    buffer: Mutex<Vec<u8>>,
    signal: Condvar,
    config: Config,
}

pub struct Config {
    pub file_path: PathBuf,
    pub max_files: usize,
    pub max_file_size: usize,
    pub buffer_capacity: usize,
}

pub fn setup_log_rotation(config: Config) -> (LogSink, LogWriter) {
    let state = Arc::new(State {
        buffer: Mutex::new(Vec::with_capacity(config.buffer_capacity)),
        signal: Condvar::new(),
        config,
    });
    (LogSink(state.clone()), LogWriter(state))
}

pub struct LogSink(Arc<State>);

pub struct LogWriter(Arc<State>);

impl io::Write for LogSink {
    fn write(&mut self, mut input: &[u8]) -> io::Result<usize> {
        let LogSink(state) = self;
        let mut locked_buffer = state.buffer.lock().into_guard();

        let remaining_capacity = state.config.buffer_capacity - locked_buffer.len();
        if remaining_capacity == 0 {
            // overwrite the end of the buffer with an error message
            let error_msg = b"\nERROR: logger queue is full, dropping messages\n";
            let start_ind = locked_buffer.len() - error_msg.len();
            locked_buffer[start_ind..].copy_from_slice(error_msg);

            return Err(io::Error::new(io::ErrorKind::WouldBlock, "log message queue is full"));
        }
        if remaining_capacity < input.len() {
            input = &input[..remaining_capacity];
        }

        locked_buffer.extend(input);
        state.signal.notify_one();
        Ok(input.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl LogWriter {
    pub fn write_logs(&mut self) -> io::Result<()> {
        let LogWriter(state) = self;

        let mut file_writer = FileRotate::new(
            &state.config.file_path,
            AppendCount::new(state.config.max_files),
            ContentLimit::Bytes(state.config.max_file_size),
            Compression::None,
            None,
        );

        let mut buffer = Vec::with_capacity(state.config.buffer_capacity);
        loop {
            // wait for data
            let mut locked_buffer = state
                .signal
                .wait_while(state.buffer.lock().into_guard(), |buf| buf.is_empty())
                .into_guard();

            // swap buffers and unlock the mutex
            mem::swap(&mut *locked_buffer, &mut buffer);
            drop(locked_buffer);

            // write to file(s)
            io::Write::write_all(&mut file_writer, &buffer)?;
            buffer.clear();
        }
    }
}

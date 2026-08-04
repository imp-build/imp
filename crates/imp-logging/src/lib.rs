#[cfg(any(test, feature = "test-support"))]
use std::sync::Arc;
use std::sync::Mutex;

static LOGGER: HostLogger = HostLogger {
    destination: Mutex::new(LogDestination::Stderr),
};

/// Make sure a logger is installed, at some level. A no-op if one is already
/// installed (e.g. by [`init_live`] or [`capture`]) — callers that just need
/// *a* logger present (rather than dictating the level) should use this, so
/// they don't clobber a level an earlier, more specific caller already chose.
pub fn ensure_installed(level: log::LevelFilter) {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(level);
    }
}

/// Change the active log level filter. Logger must already be installed via
/// [`ensure_installed`] or [`init_live`].
pub fn set_level(level: log::LevelFilter) {
    log::set_max_level(level);
}

pub fn init_live(multi: indicatif::MultiProgress, level: log::LevelFilter) {
    LOGGER.set_destination(LogDestination::Live(multi));
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(level);
}

#[cfg(any(test, feature = "test-support"))]
pub fn capture() -> Arc<Mutex<Vec<String>>> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    LOGGER.set_destination(LogDestination::Buffer(Arc::clone(&lines)));
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Trace);
    lines
}

struct HostLogger {
    destination: Mutex<LogDestination>,
}

enum LogDestination {
    Stderr,
    Live(indicatif::MultiProgress),
    #[cfg(any(test, feature = "test-support"))]
    Buffer(Arc<Mutex<Vec<String>>>),
}

impl HostLogger {
    fn set_destination(&self, destination: LogDestination) {
        *self.destination.lock().unwrap() = destination;
    }

    fn emit(&self, level: log::Level, message: &str) {
        let level = level.as_str().to_ascii_lowercase();
        let text = format!("[{level}] {message}");
        match &*self.destination.lock().unwrap() {
            LogDestination::Stderr => eprintln!("{text}"),
            LogDestination::Live(multi) => multi.suspend(|| eprintln!("{text}")),
            #[cfg(any(test, feature = "test-support"))]
            LogDestination::Buffer(lines) => lines.lock().unwrap().push(text),
        }
    }
}

impl log::Log for HostLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Trace
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let message = record.args().to_string();
        if message.is_empty() {
            self.emit(record.level(), "");
            return;
        }

        for line in message.lines() {
            self.emit(record.level(), line);
        }
    }

    fn flush(&self) {}
}

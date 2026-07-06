#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;

static LOGGER: HostLogger = HostLogger {
    destination: Mutex::new(LogDestination::Stderr),
};

pub(crate) fn ensure_installed() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Trace);
}

pub(crate) fn init_live(multi: indicatif::MultiProgress) {
    LOGGER.set_destination(LogDestination::Live(multi));
    ensure_installed();
}

#[cfg(test)]
pub(crate) fn capture() -> Arc<Mutex<Vec<String>>> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    LOGGER.set_destination(LogDestination::Buffer(Arc::clone(&lines)));
    ensure_installed();
    lines
}

struct HostLogger {
    destination: Mutex<LogDestination>,
}

enum LogDestination {
    Stderr,
    Live(indicatif::MultiProgress),
    #[cfg(test)]
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
            #[cfg(test)]
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

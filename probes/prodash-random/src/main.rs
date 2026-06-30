use std::{
    collections::VecDeque,
    env, io,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use prodash::messages::MessageLevel;

const WORKERS: usize = 4;
const LINES_PER_WORKER: usize = 80;
const DELAY_MS: u64 = 400;
const FPS: f32 = 6.0;

const WORDS: &[&str] = &[
    "configure",
    "compile",
    "archive",
    "scan",
    "cache",
    "sandbox",
    "target",
    "library",
    "resource",
    "native",
    "link",
    "header",
    "object",
    "manifest",
    "module",
    "generated",
    "process",
    "stdout",
    "stderr",
    "buffer",
    "terminal",
    "progress",
    "worker",
    "script",
    "command",
    "install",
    "probe",
    "status",
    "random",
    "message",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Messages,
    Children,
    Progress,
}

impl Mode {
    fn parse(arg: Option<&str>) -> Result<Self, String> {
        match arg.unwrap_or("messages") {
            "messages" => Ok(Self::Messages),
            "children" => Ok(Self::Children),
            "progress" => Ok(Self::Progress),
            "raw" | "mixed" => Err(format!(
                "mode '{0}' intentionally writes directly to the terminal while prodash is repainting, which corrupts the line renderer.\n\n{1}",
                arg.unwrap(),
                usage()
            )),
            "--help" | "-h" => Err(usage()),
            other => Err(format!("unknown mode: {other}\n\n{}", usage())),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Messages => "messages",
            Self::Children => "children",
            Self::Progress => "progress",
        }
    }
}

fn main() {
    let mode = match Mode::parse(env::args().nth(1).as_deref()) {
        Ok(mode) => mode,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(if message.starts_with("usage:") { 0 } else { 2 });
        }
    };

    let workers = env_usize("PRODASH_PROBE_WORKERS").unwrap_or(WORKERS);
    let lines_per_worker = env_usize("PRODASH_PROBE_LINES").unwrap_or(LINES_PER_WORKER);
    let delay_ms = env_u64("PRODASH_PROBE_DELAY_MS").unwrap_or(DELAY_MS);
    let fps = env_f32("PRODASH_PROBE_FPS").unwrap_or(FPS);

    let root = prodash::tree::Root::new();
    let title = root.add_child(format!("prodash random probe ({})", mode.name()));
    title.message(
        MessageLevel::Info,
        format!("workers={workers}, lines_per_worker={lines_per_worker}, delay_ms={delay_ms}, fps={fps}"),
    );

    let mut render_options = prodash::render::line::Options {
        throughput: false,
        initial_delay: Some(Duration::from_millis(0)),
        frames_per_second: fps,
        ..prodash::render::line::Options::default()
    }
    .auto_configure(prodash::render::line::StreamKind::Stderr);

    if env_flag("PRODASH_PROBE_FORCE_TERMINAL") {
        render_options.output_is_terminal = true;
    }

    let render = prodash::render::line::render(io::stderr(), Arc::downgrade(&root), render_options);

    let started_at = Instant::now();
    let mut handles = Vec::with_capacity(workers);
    for worker_id in 0..workers {
        let mut task = root.add_child(format!("worker {worker_id:02}"));
        task.init(Some(lines_per_worker), Some(prodash::unit::label("lines")));

        handles.push(thread::spawn(move || {
            let mut rng = Random::new(seed(worker_id));
            let mut recent_children = VecDeque::new();
            for line_index in 0..lines_per_worker {
                let text = random_line(&mut rng, worker_id, line_index);
                emit(mode, &mut task, &mut recent_children, &mut rng, &text);
                task.set(line_index + 1);
                let jitter = rng.range(0, (delay_ms / 2).max(1) as usize) as u64;
                thread::sleep(Duration::from_millis(delay_ms + jitter));
            }
            task.done(format!("{lines_per_worker} lines"));
        }));
    }

    for handle in handles {
        handle.join().expect("worker should not panic");
    }

    title.message(
        MessageLevel::Success,
        format!("finished in {:.2}s", started_at.elapsed().as_secs_f32()),
    );
    drop(title);
    render.shutdown_and_wait();
}

fn usage() -> String {
    "usage: cargo run --manifest-path probes/prodash-random/Cargo.toml -- [messages|children|progress]\n\
     \n\
     modes:\n\
       messages  emit random lines through prodash Item::message only\n\
       children  keep the last five random lines as plain child rows, without child progress bars\n\
       progress  update progress bars only, without per-line messages\n\
     \n\
     env:\n\
       PRODASH_PROBE_WORKERS=N\n\
       PRODASH_PROBE_LINES=N\n\
       PRODASH_PROBE_DELAY_MS=N\n\
       PRODASH_PROBE_FPS=N\n\
       PRODASH_PROBE_FORCE_TERMINAL=1"
        .to_owned()
}

fn env_usize(name: &str) -> Option<usize> {
    env::var(name).ok()?.parse().ok()
}

fn env_u64(name: &str) -> Option<u64> {
    env::var(name).ok()?.parse().ok()
}

fn env_f32(name: &str) -> Option<f32> {
    env::var(name).ok()?.parse().ok()
}

fn env_flag(name: &str) -> bool {
    matches!(env::var(name).as_deref(), Ok("1" | "true" | "yes" | "on"))
}

fn emit(
    mode: Mode,
    task: &mut prodash::tree::Item,
    recent_children: &mut VecDeque<prodash::tree::Item>,
    rng: &mut Random,
    text: &str,
) {
    let is_stderr = rng.one_in(3);
    let level = if is_stderr {
        MessageLevel::Failure
    } else {
        MessageLevel::Info
    };

    match mode {
        Mode::Messages => {
            task.message(level, text.to_owned());
        }
        Mode::Children => {
            let child = task.add_child(text.to_owned());
            recent_children.push_back(child);
            while recent_children.len() > 5 {
                recent_children.pop_front();
            }
        }
        Mode::Progress => {
            let _ = level;
        }
    }
}

fn random_line(rng: &mut Random, worker_id: usize, line_index: usize) -> String {
    let stream = if rng.one_in(3) { "err" } else { "out" };
    let mut line = format!("worker={worker_id:02} line={line_index:03} {stream}:");
    let words = rng.range(5, 13);
    for _ in 0..words {
        line.push(' ');
        line.push_str(WORDS[rng.range(0, WORDS.len())]);
    }
    line
}

fn seed(worker_id: usize) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    0x9e37_79b9_7f4a_7c15 ^ nanos ^ ((worker_id as u64 + 1) << 32)
}

struct Random {
    state: u64,
}

impl Random {
    fn new(seed: u64) -> Self {
        Self { state: seed.max(1) }
    }

    fn next(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    fn range(&mut self, start: usize, end: usize) -> usize {
        debug_assert!(start < end);
        start + (self.next() as usize % (end - start))
    }

    fn one_in(&mut self, chance: usize) -> bool {
        self.range(0, chance) == 0
    }
}

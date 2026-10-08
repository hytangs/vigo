//! Bounded HTTP/1.1 transport. Timetable work runs in a supervised copy of the
//! same executable so deadlines can actually stop computation and reclaim it.
use super::{Result, capabilities, fail, transport::error as json_error};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

// The supervisor owns only the encoded response, never a second journey or
// raster object tree. Deserialization below validates/skips nested fields.
struct EncodedOutput {
    bytes: Vec<u8>,
    failed: bool,
    compute_us: Option<f64>,
}
impl EncodedOutput {
    fn read(bytes: Vec<u8>) -> std::result::Result<Self, String> {
        #[derive(serde::Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct Meta {
            compute_us: Option<f64>,
        }
        fn present<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
            <serde::de::IgnoredAny as serde::Deserialize>::deserialize(d).map(|_| true)
        }
        #[derive(serde::Deserialize)]
        struct Envelope {
            #[serde(default, deserialize_with = "present")]
            error: bool,
            #[serde(default)]
            meta: Option<Meta>,
        }
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(Self {
            bytes,
            failed: envelope.error,
            compute_us: envelope.meta.and_then(|v| v.compute_us),
        })
    }
}
enum BodyData {
    Json(Value),
    Encoded(EncodedOutput),
}
struct Body {
    data: BodyData,
    queue_us: Option<u64>,
}
impl From<Value> for Body {
    fn from(value: Value) -> Self {
        Self {
            data: BodyData::Json(value),
            queue_us: None,
        }
    }
}
fn error(error: impl std::fmt::Display) -> Body {
    json_error(error).into()
}

struct Worker {
    child: Child,
    input: SyncSender<Vec<u8>>,
    output: Receiver<std::result::Result<EncodedOutput, String>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Worker {
    fn open(city: &str, timeout: Duration) -> Result<(Self, Value)> {
        let mut child = Command::new(env::current_exe()?)
            .args(["_worker", "--city", city])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or("Missing worker input")?;
        let (input, writes) = mpsc::sync_channel::<Vec<u8>>(1);
        // A stopped child can fill its stdin pipe. Keep that blocking write off
        // the supervisor so the same deadline covers dispatch and computation.
        thread::spawn(move || {
            for bytes in writes {
                if stdin
                    .write_all(&bytes)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let stdout = child.stdout.take().ok_or("Missing worker output")?;
        let (sender, output) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let message = match reader
                    .by_ref()
                    .take(64 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(n) if n <= 64 * 1024 * 1024 => EncodedOutput::read(line),
                    Ok(_) => Err("Worker output exceeds 64 MiB".into()),
                    Err(e) => Err(e.to_string()),
                };
                if sender.send(message).is_err() {
                    break;
                }
            }
        });
        let worker = Self {
            child,
            input,
            output,
        };
        let startup = worker
            .output
            .recv_timeout(timeout)
            .map_err(|_| "City worker startup timed out or exited")??;
        let startup: Value = serde_json::from_slice(&startup.bytes)?;
        if startup["ready"] != true {
            return fail("City worker did not become ready");
        }
        Ok((worker, startup["info"].clone()))
    }
    fn query(
        &mut self,
        q: &Value,
        timeout: Duration,
        canceled: &AtomicBool,
    ) -> Result<EncodedOutput> {
        let deadline = Instant::now() + timeout;
        let mut bytes = serde_json::to_vec(q)?;
        bytes.push(b'\n');
        self.input
            .try_send(bytes)
            .map_err(|_| "City worker input is unavailable")?;
        loop {
            if canceled.load(Ordering::Acquire) {
                return fail("Query canceled");
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return fail("Query deadline exceeded");
            }
            match self
                .output
                .recv_timeout(remaining.min(Duration::from_millis(20)))
            {
                Ok(value) => return Ok(value?),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return fail("City worker exited"),
            }
        }
    }
}
struct Job {
    queued_at: Instant,
    query: Value,
    deadline: Instant,
    response: SyncSender<(u16, Body)>,
    canceled: Arc<AtomicBool>,
}
// Route requests and small matrices can pass waiting analytical jobs. A bounded
// burst is followed by the oldest analytical job, so a sustained
// route stream cannot starve Reach. Running queries are never interrupted.
fn short_query(query: &Value) -> bool {
    match query["kind"].as_str() {
        Some("route" | "info") => true,
        Some("matrix") => query["origins"]
            .as_array()
            .zip(query["destinations"].as_array())
            .is_some_and(|(a, b)| a.len().saturating_mul(b.len()) <= 1024),
        _ => false,
    }
}
fn next_job(pending: &mut VecDeque<Job>, short_streak: &mut usize, short_time: Duration) -> Job {
    let desired_short = *short_streak < 32 && short_time < Duration::from_millis(250);
    let index = pending
        .iter()
        .position(|job| short_query(&job.query) == desired_short)
        .unwrap_or(0);
    let job = pending.remove(index).expect("nonempty pending queue");
    *short_streak = if short_query(&job.query) {
        (*short_streak + 1).min(32)
    } else {
        0
    };
    job
}
struct State {
    token: Option<String>,
    maximum: usize,
    io_timeout: Duration,
    query_timeout: Duration,
    sender: SyncSender<Job>,
    queue_limit: usize,
    queued: AtomicUsize,
    ready: AtomicBool,
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
fn setting(
    o: &HashMap<String, String>,
    name: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize> {
    let n = o
        .get(name)
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(default);
    if !(minimum..=maximum).contains(&n) {
        return fail(format!("{name} must be {minimum}..{maximum}"));
    }
    Ok(n)
}
pub(crate) fn serve(city: &str, o: &HashMap<String, String>) -> Result<()> {
    let host: IpAddr = o
        .get("host")
        .map(String::as_str)
        .unwrap_or("127.0.0.1")
        .parse()?;
    let port: u16 = o
        .get("port")
        .cloned()
        .or_else(|| env::var("PORT").ok())
        .unwrap_or("8080".into())
        .parse()?;
    let token = env::var("VIGO_API_TOKEN").ok().filter(|s| !s.is_empty());
    if !host.is_loopback() && token.as_ref().is_none_or(|s| s.len() < 16) {
        return fail("Non-loopback HTTP requires VIGO_API_TOKEN with at least 16 characters");
    }
    let maximum = setting(o, "max-body-bytes", 8 * 1024 * 1024, 1024, 8 * 1024 * 1024)?;
    let io_timeout =
        Duration::from_millis(setting(o, "request-timeout-ms", 10_000, 50, 60_000)? as u64);
    let query_timeout =
        Duration::from_millis(setting(o, "query-timeout-ms", 30_000, 1, 600_000)? as u64);
    let connections = setting(o, "max-connections", 32, 2, 256)?;
    let queue = setting(o, "max-queue", 8, 0, 128)?;
    let startup_timeout = Duration::from_secs(60);
    let (worker, info) = Worker::open(city, startup_timeout)?;
    let (sender, receiver) = mpsc::sync_channel::<Job>(queue);
    let state = Arc::new(State {
        token,
        maximum,
        io_timeout,
        query_timeout,
        sender,
        queue_limit: queue,
        queued: AtomicUsize::new(0),
        ready: AtomicBool::new(true),
        requests: Mutex::new(HashMap::new()),
    });
    let supervisor = state.clone();
    let city = city.to_owned();
    thread::spawn(move || {
        let mut worker = Some(worker);
        let mut pending = VecDeque::new();
        let mut short_streak = 0;
        let mut short_time = Duration::ZERO;
        loop {
            if pending.is_empty() {
                let job = match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(job) => job,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if worker
                            .as_mut()
                            .is_some_and(|w| !matches!(w.child.try_wait(), Ok(None)))
                        {
                            supervisor.ready.store(false, Ordering::Release);
                            drop(worker.take());
                        }
                        if worker.is_none() {
                            worker = Worker::open(&city, startup_timeout).ok().map(|v| v.0);
                            supervisor.ready.store(worker.is_some(), Ordering::Release);
                        }
                        continue;
                    }
                };
                pending.push_back(job);
            }
            while let Ok(job) = receiver.try_recv() {
                pending.push_back(job);
            }
            let job = next_job(&mut pending, &mut short_streak, short_time);
            if queue > 0 {
                supervisor.queued.fetch_sub(1, Ordering::AcqRel);
            }
            if job.canceled.load(Ordering::Acquire) {
                let _ = job.response.send((499, error("Query canceled")));
                continue;
            }
            if Instant::now() >= job.deadline {
                let _ = job.response.send((504, error("Query expired in queue")));
                continue;
            }
            if worker.is_none() {
                worker = Worker::open(&city, startup_timeout).ok().map(|v| v.0);
                supervisor.ready.store(worker.is_some(), Ordering::Release);
            }
            let queue_us = job.queued_at.elapsed().as_micros() as u64;
            let compute_started = Instant::now();
            let mut response = match worker.as_mut() {
                None => (503, error("City worker is unavailable")),
                Some(w) => match w.query(
                    &job.query,
                    job.deadline.saturating_duration_since(Instant::now()),
                    &job.canceled,
                ) {
                    Ok(v) => (
                        if v.failed { 400 } else { 200 },
                        Body {
                            data: BodyData::Encoded(v),
                            queue_us: None,
                        },
                    ),
                    Err(_) => {
                        supervisor.ready.store(false, Ordering::Release);
                        drop(worker.take());
                        (
                            if job.canceled.load(Ordering::Acquire) {
                                499
                            } else {
                                504
                            },
                            error(if job.canceled.load(Ordering::Acquire) {
                                "Query canceled; worker discarded"
                            } else {
                                "Query deadline exceeded or City worker exited; worker discarded"
                            }),
                        )
                    }
                },
            };
            short_time = if short_query(&job.query) {
                short_time.saturating_add(compute_started.elapsed())
            } else {
                Duration::ZERO
            };
            response.1.queue_us = Some(queue_us);
            let _ = job.response.send(response);
            if worker.is_none() {
                worker = Worker::open(&city, startup_timeout).ok().map(|v| v.0);
                supervisor.ready.store(worker.is_some(), Ordering::Release);
            }
        }
    });
    let server = TcpListener::bind((host, port))?;
    eprintln!(
        "VIGO Rust listening on {} (City: {})",
        server.local_addr()?,
        info["name"]
    );
    let active = Arc::new(AtomicUsize::new(0));
    for stream in server.incoming() {
        let mut stream = stream?;
        stream.set_write_timeout(Some(io_timeout))?;
        if active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < connections).then_some(n + 1)
            })
            .is_err()
        {
            stream.set_write_timeout(Some(Duration::from_millis(50)))?;
            let _ = respond(&mut stream, 503, error("Connection capacity reached"));
            continue;
        }
        let active = active.clone();
        let state = state.clone();
        thread::spawn(move || {
            struct Lease(Arc<AtomicUsize>);
            impl Drop for Lease {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _lease = Lease(active);
            let result = handle(&mut stream, &state);
            let response = result.unwrap_or_else(|e| {
                Response::Json((
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) {
                        408
                    } else {
                        400
                    },
                    error("Invalid or incomplete HTTP request"),
                ))
            });
            let _ = match response {
                Response::Json((status, value)) => respond(&mut stream, status, value),
                Response::Static(content_type, bytes) => {
                    respond_bytes(&mut stream, 200, content_type, bytes)
                }
            };
        });
    }
    Ok(())
}
fn invalid() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid HTTP framing")
}
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for (i, &x) in a.iter().enumerate() {
        diff |= usize::from(x ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}
fn remaining(stream: &TcpStream, deadline: Instant) -> std::io::Result<()> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::TimedOut))?;
    stream.set_read_timeout(Some(remaining))
}
enum Response {
    Json((u16, Body)),
    Static(&'static str, &'static [u8]),
}
fn handle(stream: &mut TcpStream, state: &State) -> std::io::Result<Response> {
    let deadline = Instant::now() + state.io_timeout;
    let mut bytes = Vec::new();
    let header_end = loop {
        remaining(stream, deadline)?;
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break i + 4;
        }
        if bytes.len() > 16 * 1024 {
            return Ok(Response::Json((431, error("HTTP headers exceed 16 KiB"))));
        }
    };
    if header_end > 16 * 1024 {
        return Ok(Response::Json((431, error("HTTP headers exceed 16 KiB"))));
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    request.parse(&bytes[..header_end]).map_err(|_| invalid())?;
    let target = request.path.ok_or_else(invalid)?;
    let (path, parameters) = target.split_once('?').unwrap_or((target, ""));
    let method = request.method.ok_or_else(invalid)?;
    let get = |name: &str| -> std::io::Result<Option<&[u8]>> {
        let mut values = request
            .headers
            .iter()
            .filter(|h| h.name.eq_ignore_ascii_case(name));
        let value = values.next().map(|v| v.value);
        if values.next().is_some() {
            return Err(invalid());
        }
        Ok(value)
    };
    if request.version == Some(1) && get("Host")?.is_none() {
        return Err(invalid());
    }
    // These immutable assets contain no City, query, or authentication data.
    // Embedding them keeps both the local and deployed manual fully standalone.
    if method == "GET" {
        if ["/", "/docs", "/docs/"].contains(&path) {
            return Ok(Response::Static(
                "text/html; charset=utf-8",
                include_bytes!("../../../../docs/standalone.html"),
            ));
        }
        if [
            "/openapi.json",
            "/docs/openapi.json",
            "/standalone-openapi.json",
            "/docs/standalone-openapi.json",
        ]
        .contains(&path)
        {
            return Ok(Response::Static(
                "application/json; charset=utf-8",
                include_bytes!("../../../../docs/standalone-openapi.json"),
            ));
        }
    }
    (|| -> std::io::Result<(u16, Body)> {
    if method == "GET" && ["/healthz", "/readyz"].contains(&path) {
        let ready = state.ready.load(Ordering::Acquire);
        return Ok((
            if path == "/readyz" && !ready {
                503
            } else {
                200
            },
            json!({"status":if ready {"ready"} else {"recovering"},"runtime":"rust","version":env!("CARGO_PKG_VERSION")}).into(),
        ));
    }
    if state.token.as_ref().is_some_and(|t| {
        !constant_eq(
            get("Authorization").ok().flatten().unwrap_or(&[]),
            format!("Bearer {t}").as_bytes(),
        )
    }) {
        return Ok((401, error("Bearer authentication required")));
    }
    if method == "GET" && path == "/v1/capabilities" {
        return Ok((200, capabilities().into()));
    }
    if method == "GET" && path == "/v1/info" {
        return dispatch(state, json!({"kind":"info"}));
    }
    if method == "DELETE" && path.starts_with("/v1/requests/") {
        let id = path.trim_start_matches("/v1/requests/");
        let requests = state.requests.lock().map_err(|_| invalid())?;
        if let Some(canceled) = requests.get(id) {
            canceled.store(true, Ordering::Release);
            return Ok((202, json!({"status":"canceling","requestId":id}).into()));
        }
        return Ok((404, error("No active request with this ID")));
    }
    if method != "POST"
        || ![
            "/v1/route",
            "/v1/matrix",
            "/v1/reach",
            "/v1/isochrone",
            "/v1/compare",
            "/v1/native",
        ]
        .contains(&path)
    {
        return Ok((404, error("Endpoint not found")));
    }
    let kind = path.trim_start_matches("/v1/").to_owned();
    let length = get("Content-Length")?
        .map(|v| {
            std::str::from_utf8(v).map_err(|_| invalid()).and_then(|s| {
                if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                    s.parse::<usize>().map_err(|_| invalid())
                } else {
                    Err(invalid())
                }
            })
        })
        .transpose()?;
    let chunked = get("Transfer-Encoding")?;
    if chunked.is_some_and(|v| !v.eq_ignore_ascii_case(b"chunked"))
        || (chunked.is_some() && length.is_some())
    {
        return Err(invalid());
    }
    if length.is_some_and(|n| n > state.maximum) {
        return Ok((413, error("Request body exceeds configured limit")));
    }
    if let Some(expect) = get("Expect")? {
        if !expect.eq_ignore_ascii_case(b"100-continue") {
            return Ok((417, error("Unsupported expectation")));
        }
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
    }
    let buffered = bytes[header_end..].to_vec();
    let mut body = Vec::new();
    let mut input = std::io::Cursor::new(buffered).chain(DeadlineReader { stream, deadline });
    if chunked.is_some() {
        let mut reader = BufReader::new(&mut input);
        loop {
            // Update the socket deadline even when reading a chunked body.

            let mut line = Vec::new();
            reader.by_ref().take(1025).read_until(b'\n', &mut line)?;
            if line.len() > 1024 || !line.ends_with(b"\r\n") {
                return Err(invalid());
            }
            let text = std::str::from_utf8(&line[..line.len() - 2]).map_err(|_| invalid())?;
            let digits = text.split(';').next().unwrap_or("");
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid());
            }
            let size = usize::from_str_radix(digits, 16).map_err(|_| invalid())?;
            if size > state.maximum - body.len() {
                return Ok((413, error("Request body exceeds configured limit")));
            }
            if size == 0 {
                let mut trailer = Vec::new();
                loop {
                    let mut line = Vec::new();
                    reader.by_ref().take(1025).read_until(b'\n', &mut line)?;
                    if line.len() > 1024 || !line.ends_with(b"\r\n") {
                        return Err(invalid());
                    }
                    trailer.extend(&line);
                    if trailer.len() > 16 * 1024 {
                        return Err(invalid());
                    }
                    if line == b"\r\n" {
                        break;
                    }
                }
                let mut headers = [httparse::EMPTY_HEADER; 64];
                httparse::parse_headers(&trailer, &mut headers).map_err(|_| invalid())?;
                break;
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
            let mut end = [0; 2];
            reader.read_exact(&mut end)?;
            if end != *b"\r\n" {
                return Err(invalid());
            }
        }
    } else {
        let size = length.unwrap_or(0);
        while body.len() < size {
            let mut chunk = [0u8; 8192];
            let limit = chunk.len().min(size - body.len());
            let n = input.read(&mut chunk[..limit])?;
            if n == 0 {
                return Err(invalid());
            }
            body.extend_from_slice(&chunk[..n]);
        }
    }
    let mut query: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return Ok((400, error("Request must be valid JSON"))),
    };
    if !query.is_object() {
        return Ok((400, error("Request must be a JSON object")));
    }
    for pair in parameters.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = if key == "vigo_diagnostics" { "diagnostics" } else { key };
        let value = match key {
            "diagnostics" => json!(value),
            "includeGeometry" | "includeLimitations" => match value {
                "true" => json!(true), "false" => json!(false),
                _ => return Ok((400, error("Output query flags must be true or false"))),
            },
            _ => return Ok((400, error("Unknown URL query option"))),
        };
        if query.get(key).is_some_and(|old| old != &value) { return Ok((400, error("Conflicting body and URL output options"))); }
        query[key] = value;
    }
    if let Err(e) = crate::presentation::validate(&query) { return Ok((400, error(e))); }
    query["kind"] = json!(kind);
    dispatch(state, query)
    })().map(Response::Json)
}
fn dispatch(state: &State, query: Value) -> std::io::Result<(u16, Body)> {
    let canceled = Arc::new(AtomicBool::new(false));
    let id = query["id"].as_str().map(str::to_owned);
    if let Some(id) = &id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Ok((
                400,
                error(
                    "Request id must contain 1 to 128 letters, digits, hyphens, underscores or periods",
                ),
            ));
        }
        let mut requests = state.requests.lock().map_err(|_| invalid())?;
        if requests.contains_key(id) {
            return Ok((409, error("Request id is already active")));
        }
        requests.insert(id.clone(), canceled.clone());
    }
    let run = || {
        let (sender, receiver) = mpsc::sync_channel(1);
        let job = Job {
            queued_at: Instant::now(),
            query,
            deadline: Instant::now() + state.query_timeout,
            response: sender,
            canceled: canceled.clone(),
        };
        // Count both the channel and the supervisor's pending jobs under one
        // admission limit. A zero-capacity channel remains a direct handoff.
        if state.queue_limit > 0
            && state
                .queued
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < state.queue_limit).then_some(n + 1)
                })
                .is_err()
        {
            return (503, error("Query queue is full"));
        }
        if let Err(e) = state.sender.try_send(job) {
            if state.queue_limit > 0 {
                state.queued.fetch_sub(1, Ordering::AcqRel);
            }
            return match e {
                TrySendError::Full(_) => (503, error("Query queue is full")),
                TrySendError::Disconnected(_) => (503, error("Query worker is unavailable")),
            };
        }
        receiver
            .recv_timeout(state.query_timeout + Duration::from_millis(100))
            .unwrap_or_else(|_| {
                canceled.store(true, Ordering::Release);
                (504, error("Query deadline exceeded"))
            })
    };
    let result = run();
    if let Some(id) = id {
        state.requests.lock().map_err(|_| invalid())?.remove(&id);
    }
    Ok(result)
}

fn respond(stream: &mut TcpStream, status: u16, body: Body) -> std::io::Result<()> {
    let queue_us = body.queue_us;
    let mut value = match body.data {
        BodyData::Json(value) => value,
        BodyData::Encoded(output) => {
            let mut timing = String::from("Server-Timing: serialize;dur=0");
            if let Some(us) = queue_us {
                timing.push_str(&format!(", queue;dur={:.3}", us as f64 / 1000.));
            }
            if let Some(us) = output.compute_us {
                timing.push_str(&format!(", compute;dur={:.3}", us / 1000.));
            }
            timing.push_str("\r\n");
            return respond_with_headers(
                stream,
                status,
                "application/json; charset=utf-8",
                &output.bytes,
                &timing,
            );
        }
    };
    if value["error"]["code"] == "invalid_request" {
        let code = match status {
            401 => "unauthorized",
            404 => "endpoint_not_found",
            408 => "request_timeout",
            409 => "request_id_conflict",
            499 => "query_canceled",
            413 => "request_too_large",
            431 => "headers_too_large",
            503 => "service_unavailable",
            504 => "query_timeout",
            _ => "invalid_request",
        };
        value["error"]["code"] = json!(code);
    }
    let started = Instant::now();
    let body = serde_json::to_vec(&value)?;
    let serialization_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut timing = format!("Server-Timing: serialize;dur={serialization_ms:.3}");
    if let Some(us) = queue_us {
        timing.push_str(&format!(", queue;dur={:.3}", us as f64 / 1000.));
    }
    if let Some(us) = value["meta"]["computeUs"].as_f64() {
        timing.push_str(&format!(", compute;dur={:.3}", us / 1000.));
    }
    timing.push_str("\r\n");
    respond_with_headers(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        &timing,
    )
}

fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    respond_with_headers(stream, status, content_type, body, "")
}
fn respond_with_headers(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    headers: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Content Too Large",
        417 => "Expectation Failed",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n{headers}\r\n",
        body.len()
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut written = 0;
    while written < body.len() {
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::TimedOut))?;
        stream.set_write_timeout(Some(timeout))?;
        let n = stream.write(&body[written..])?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        written += n;
    }
    Ok(())
}
struct DeadlineReader<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}
impl Read for DeadlineReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        remaining(self.stream, self.deadline)?;
        self.stream.read(buffer)
    }
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    #[test]
    fn response_forwarding_validates_without_rebuilding_the_body() {
        let bytes = br#"{"journey":{"legs":[{"geometry":[1,2.123456789,3]}]},"meta":{"computeUs":1234},"status":"ok"}"#.to_vec();
        let pointer = bytes.as_ptr();
        let response = EncodedOutput::read(bytes).unwrap();
        assert_eq!(response.bytes.as_ptr(), pointer);
        assert!(!response.failed);
        assert_eq!(response.compute_us, Some(1234.));
        assert!(
            EncodedOutput::read(br#"{"error":null}"#.to_vec())
                .unwrap()
                .failed
        );
        assert!(EncodedOutput::read(br#"{"journey":[1,broken]}"#.to_vec()).is_err());
    }
    #[test]
    fn routes_pass_waiting_surfaces_without_starving_them() {
        let mut queue = VecDeque::new();
        let mut push = |kind: &str, id: usize| {
            let (response, _) = mpsc::sync_channel(1);
            queue.push_back(Job {
                queued_at: Instant::now(),
                query: json!({"kind":kind,"id":id}),
                deadline: Instant::now() + Duration::from_secs(60),
                response,
                canceled: Arc::new(AtomicBool::new(false)),
            });
        };
        for id in 0..3 {
            push("reach", id);
        }
        for id in 3..72 {
            push("route", id);
        }
        let mut streak = 0;
        let mut order = Vec::new();
        while !queue.is_empty() {
            order.push(
                next_job(&mut queue, &mut streak, Duration::ZERO).query["id"]
                    .as_u64()
                    .unwrap(),
            );
        }
        assert_eq!(
            order,
            (3..35)
                .chain([0])
                .chain(35..67)
                .chain([1])
                .chain(67..72)
                .chain([2])
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn only_bounded_matrices_join_the_route_queue() {
        assert!(short_query(
            &json!({"kind":"matrix","origins":[1],"destinations":vec![0;1024]})
        ));
        assert!(!short_query(
            &json!({"kind":"matrix","origins":[1,2],"destinations":vec![0;1024]})
        ));
        assert!(!short_query(
            &json!({"kind":"native","operation":"street.surface"})
        ));
    }
}

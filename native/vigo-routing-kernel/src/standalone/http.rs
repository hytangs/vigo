//! Bounded HTTP/1.1 transport. Timetable work runs in a supervised copy of the
//! same executable so deadlines can actually stop computation and reclaim it.
use super::{Result, capabilities, fail, transport::error};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

struct Worker {
    child: Child,
    input: SyncSender<Vec<u8>>,
    output: Receiver<std::result::Result<Value, String>>,
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
                    Ok(n) if n <= 64 * 1024 * 1024 => {
                        serde_json::from_slice(&line).map_err(|e| e.to_string())
                    }
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
        if startup["ready"] != true {
            return fail("City worker did not become ready");
        }
        Ok((worker, startup["info"].clone()))
    }
    fn query(&mut self, q: &Value, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        let mut bytes = serde_json::to_vec(q)?;
        bytes.push(b'\n');
        self.input
            .try_send(bytes)
            .map_err(|_| "City worker input is unavailable")?;
        Ok(self
            .output
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "Query deadline exceeded or City worker exited")??)
    }
}
struct Job {
    query: Value,
    deadline: Instant,
    response: SyncSender<(u16, Value)>,
}
struct State {
    token: Option<String>,
    maximum: usize,
    io_timeout: Duration,
    query_timeout: Duration,
    sender: SyncSender<Job>,
    ready: AtomicBool,
    info: Value,
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
        ready: AtomicBool::new(true),
        info,
    });
    let supervisor = state.clone();
    let city = city.to_owned();
    thread::spawn(move || {
        let mut worker = Some(worker);
        loop {
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
            if Instant::now() >= job.deadline {
                let _ = job.response.send((504, error("Query expired in queue")));
                continue;
            }
            if worker.is_none() {
                worker = Worker::open(&city, startup_timeout).ok().map(|v| v.0);
                supervisor.ready.store(worker.is_some(), Ordering::Release);
            }
            let response = match worker.as_mut() {
                None => (503, error("City worker is unavailable")),
                Some(w) => match w.query(
                    &job.query,
                    job.deadline.saturating_duration_since(Instant::now()),
                ) {
                    Ok(v) => (if v.get("error").is_some() { 400 } else { 200 }, v),
                    Err(_) => {
                        supervisor.ready.store(false, Ordering::Release);
                        drop(worker.take());
                        (
                            504,
                            error(
                                "Query deadline exceeded or City worker exited; worker discarded",
                            ),
                        )
                    }
                },
            };
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
        state.info["name"]
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
            let _ = respond(&mut stream, 503, &error("Connection capacity reached"));
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
                Response::Json((status, value)) => respond(&mut stream, status, &value),
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
    Json((u16, Value)),
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
    let path = request
        .path
        .ok_or_else(invalid)?
        .split('?')
        .next()
        .unwrap_or("");
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
    (|| -> std::io::Result<(u16, Value)> {
    if method == "GET" && ["/healthz", "/readyz"].contains(&path) {
        let ready = state.ready.load(Ordering::Acquire);
        return Ok((
            if path == "/readyz" && !ready {
                503
            } else {
                200
            },
            json!({"status":if ready {"ready"} else {"recovering"},"runtime":"rust","version":env!("CARGO_PKG_VERSION")}),
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
        return Ok((200, capabilities()));
    }
    if method == "GET" && path == "/v1/info" {
        return Ok((200, state.info.clone()));
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
    query["kind"] = json!(kind);
    let (sender, receiver) = mpsc::sync_channel(1);
    let deadline = Instant::now() + state.query_timeout;
    let job = Job {
        query,
        deadline,
        response: sender,
    };
    match state.sender.try_send(job) {
        Err(TrySendError::Full(_)) => return Ok((503, error("Query queue is full"))),
        Err(TrySendError::Disconnected(_)) => {
            return Ok((503, error("Query worker is unavailable")));
        }
        Ok(()) => {}
    }
    Ok(receiver
        .recv_timeout(state.query_timeout + Duration::from_millis(100))
        .unwrap_or_else(|_| (504, error("Query deadline exceeded"))))
    })().map(Response::Json)
}
fn respond(stream: &mut TcpStream, status: u16, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)?;
    respond_bytes(stream, status, "application/json; charset=utf-8", &body)
}
fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
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
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n\r\n",
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

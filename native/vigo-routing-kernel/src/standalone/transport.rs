use super::{City, Result, capabilities, fail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, BufRead, Read, Write},
    path::Path,
};

const HELP: &str = "VIGO — standalone Rust routing and isochrones

  vigo serve --city ./city --host 0.0.0.0 --port 8080
  vigo route --city ./city --request route.json
  vigo matrix --city ./city --request matrix.json
  vigo reach --city ./city --request reach.json
  vigo compare --city ./city --request comparison.json
  vigo stream --city ./city < requests.ndjson
  vigo info --city ./city
  vigo capabilities
  vigo native --city ./city --request kernel-query.json

Use --request - for stdin; --output FILE saves JSON; --pretty indents JSON.
Common flags: --service-date YYYY-MM-DD --time HH:MM --mode transit|walk|drive
--from lon,lat|stop:ID --to lon,lat|stop:ID --max-walk KM --arrive-by

HTTP: GET /healthz, /readyz, /v1/capabilities, /v1/info
      POST /v1/route, /v1/matrix, /v1/reach, /v1/compare, /v1/native
Set VIGO_API_TOKEN for bearer authentication. Non-loopback binds require it.
VIGO_CITY and PORT supply deployment defaults. City files are read-only.
No Node runtime or internet connection is needed for routing.
";
pub(crate) fn error(error: impl std::fmt::Display) -> Value {
    json!({"error":{"code":"invalid_request","message":error.to_string()}})
}
pub fn main() -> i32 {
    match run() {
        Ok(()) => 0,
        Err(e) => {
            if e.downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
            {
                return 0;
            }
            eprintln!("{}", error(e));
            2
        }
    }
}
fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or("help".into());
    if ["help", "--help", "-h"].contains(&command.as_str()) {
        print!("{HELP}");
        return Ok(());
    }
    if ["version", "--version", "-V"].contains(&command.as_str()) {
        println!("vigo {} (standalone Rust)", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let mut options = HashMap::new();
    while let Some(arg) = args.next() {
        if !arg.starts_with("--") {
            return fail(format!("Unexpected argument {arg}"));
        }
        let raw = &arg[2..];
        let (name, value) = if let Some((k, v)) = raw.split_once('=') {
            (k.to_owned(), v.to_owned())
        } else if ["pretty", "arrive-by", "street-edges", "help"].contains(&raw) {
            (raw.into(), "true".into())
        } else {
            (
                raw.into(),
                args.next()
                    .ok_or_else(|| format!("Missing value for {arg}"))?,
            )
        };
        if options.insert(name.clone(), value).is_some() {
            return fail(format!("Duplicate option --{name}"));
        }
    }
    if options.contains_key("help") {
        print!("{HELP}");
        return Ok(());
    }
    if ![
        "capabilities",
        "info",
        "route",
        "matrix",
        "reach",
        "isochrone",
        "compare",
        "native",
        "stream",
        "serve",
        "_worker",
    ]
    .contains(&command.as_str())
    {
        return fail(format!("Unknown command {command}"));
    }
    let known = [
        "city",
        "request",
        "output",
        "pretty",
        "host",
        "port",
        "max-body-bytes",
        "request-timeout-ms",
        "query-timeout-ms",
        "max-connections",
        "max-queue",
        "service-date",
        "time",
        "mode",
        "from",
        "to",
        "max-walk",
        "max-street",
        "max-transfers",
        "horizon",
        "arrive-by",
        "street-edges",
        "raster-size",
        "cutoffs",
        "radius",
    ];
    for key in options.keys() {
        if !known.contains(&key.as_str()) {
            return fail(format!("Unknown option --{key}"));
        }
        let allowed = match key.as_str() {
            "city" => command != "capabilities",
            "host" | "port" | "max-body-bytes" | "request-timeout-ms" | "query-timeout-ms"
            | "max-connections" | "max-queue" => command == "serve",
            "request" => ["route", "matrix", "reach", "isochrone", "compare", "native"]
                .contains(&command.as_str()),
            "output" | "pretty" => !["serve", "stream", "_worker"].contains(&command.as_str()),
            "service-date" => ["route", "matrix", "reach", "isochrone", "native", "stream"]
                .contains(&command.as_str()),
            "from" => ["route", "reach", "isochrone"].contains(&command.as_str()),
            "to" => command == "route",
            "street-edges" | "raster-size" | "cutoffs" | "radius" => {
                ["reach", "isochrone"].contains(&command.as_str())
            }
            "arrive-by" | "max-street" | "horizon" => {
                ["route", "matrix"].contains(&command.as_str())
            }
            _ => ["route", "matrix", "reach", "isochrone", "stream"].contains(&command.as_str()),
        };
        if !allowed {
            return fail(format!("Option --{key} does not apply to {command}"));
        }
    }
    if command == "capabilities" {
        return output(&capabilities(), &options);
    }
    let city_path = options
        .get("city")
        .cloned()
        .or_else(|| env::var("VIGO_CITY").ok())
        .ok_or("--city or VIGO_CITY is required")?;
    if command == "serve" {
        return super::http::serve(&city_path, &options);
    }
    let mut city = City::open(&city_path)?;
    if command == "_worker" {
        println!("{}", serde_json::json!({"ready":true,"info":city.info()}));
        io::stdout().flush()?;
    }
    if command == "stream" || command == "_worker" {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        // Bound serialization scratch even for huge matrices. Larger chunks
        // reduce pipe writes without retaining a second complete response.
        let mut stdout = io::BufWriter::with_capacity(64 * 1024, io::stdout().lock());
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            let read = reader
                .by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes)?;
            if read == 0 {
                break;
            }
            if read > 8 * 1024 * 1024 {
                return fail("NDJSON line exceeds 8 MiB");
            }
            if bytes.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value: std::result::Result<Value, _> = serde_json::from_slice(&bytes);
            let result = match value {
                Ok(mut q) => {
                    let kind = q["kind"].as_str().unwrap_or("").to_owned();
                    let id = q.get("id").cloned();
                    let mut result = apply_flags(&mut q, &options)
                        .and_then(|()| city.execute(&kind, &q))
                        .unwrap_or_else(error);
                    if let Some(id) = id {
                        result["id"] = id;
                    }
                    result
                }
                Err(e) => error(e),
            };
            serde_json::to_writer(&mut stdout, &result)?;
            writeln!(stdout)?;
            stdout.flush()?;
        }
        return Ok(());
    }
    let mut request = if let Some(file) = options.get("request") {
        if file == "-" {
            request_json(io::stdin())?
        } else {
            request_json(fs::File::open(file)?)?
        }
    } else {
        json!({})
    };
    apply_flags(&mut request, &options)?;
    let result = city.execute(&command, &request)?;
    output(&result, &options)
}
fn output(value: &Value, options: &HashMap<String, String>) -> Result<()> {
    let mut bytes = if enabled(options, "pretty")? {
        serde_json::to_vec_pretty(value)?
    } else {
        serde_json::to_vec(value)?
    };
    bytes.push(b'\n');
    if let Some(path) = options.get("output").filter(|p| p.as_str() != "-") {
        let requested = Path::new(path);
        let path = if fs::symlink_metadata(requested).is_ok() {
            fs::canonicalize(requested)?
        } else {
            requested.to_owned()
        };
        let metadata = fs::metadata(&path).ok();
        if metadata.as_ref().is_some_and(|m| !m.is_file()) {
            return fail("Output must be a file");
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let temp = path.with_extension(format!("{}.{stamp}.tmp", std::process::id()));
        let result = (|| -> Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            if let Some(metadata) = metadata {
                file.set_permissions(metadata.permissions())?;
            }
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
    } else {
        io::stdout().write_all(&bytes)?;
    }
    Ok(())
}
fn enabled(options: &HashMap<String, String>, name: &str) -> Result<bool> {
    match options.get(name).map(String::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => fail(format!("--{name} expects true or false")),
    }
}
fn request_json(reader: impl Read) -> Result<Value> {
    let mut bytes = Vec::new();
    reader.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return fail("Request exceeds 8 MiB");
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    Ok(serde_json::from_slice(bytes)?)
}
fn apply_flags(q: &mut Value, o: &HashMap<String, String>) -> Result<()> {
    if !q.is_object() {
        return fail("Request must be a JSON object");
    }
    for (cli, key) in [
        ("service-date", "serviceDate"),
        ("time", "time"),
        ("mode", "mode"),
    ] {
        if let Some(v) = o.get(cli) {
            if key == "time" {
                q.as_object_mut().unwrap().remove("timeMinutes");
            }
            q[key] = json!(v);
        }
    }
    for (cli, key) in [
        ("max-walk", "maxWalkKm"),
        ("max-street", "maxStreetKm"),
        ("horizon", "horizonMinutes"),
        ("raster-size", "rasterSize"),
        ("radius", "extentRadiusKm"),
        ("max-transfers", "maxTransfers"),
    ] {
        if let Some(v) = o.get(cli) {
            q[key] = serde_json::from_str(v)?;
        }
    }
    for (cli, key) in [("from", "origin"), ("to", "destination")] {
        if let Some(v) = o.get(cli) {
            q[key] = if let Some(id) = v.strip_prefix("stop:") {
                json!({"stopId":id})
            } else {
                let coords = v
                    .split(',')
                    .map(str::parse::<f64>)
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                json!({"coordinate":coords})
            };
        }
    }
    if o.contains_key("arrive-by") {
        q["timePreference"] = json!(if enabled(o, "arrive-by")? {
            "arrive_by"
        } else {
            "depart_at"
        });
    }
    if o.contains_key("street-edges") {
        q["includeStreetEdges"] = json!(enabled(o, "street-edges")?);
    }
    if let Some(v) = o.get("cutoffs") {
        q["cutoffsMinutes"] = json!(
            v.split(',')
                .map(str::parse::<f64>)
                .collect::<std::result::Result<Vec<_>, _>>()?
        );
    }
    Ok(())
}

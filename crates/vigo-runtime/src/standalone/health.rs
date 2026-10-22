use super::{Result, fail};
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

// A readiness probe uses no City data, routing workspace, or external runtime.
pub(crate) fn run(options: &HashMap<String, String>) -> Result<()> {
    let host: IpAddr = options
        .get("host")
        .map(String::as_str)
        .unwrap_or("127.0.0.1")
        .parse()?;
    let port = options
        .get("port")
        .cloned()
        .or_else(|| env::var("PORT").ok())
        .unwrap_or("8080".into())
        .parse()?;
    check(SocketAddr::new(host, port), Duration::from_secs(2))?;
    println!("ready");
    Ok(())
}

fn check(address: SocketAddr, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "GET /readyz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )?;
    let mut line = Vec::with_capacity(64);
    while line.len() < 256 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Readiness probe timed out")?;
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        line.push(byte[0]);
        if byte[0] == b'\n' {
            let status = std::str::from_utf8(&line)?;
            let mut fields = status.split_ascii_whitespace();
            if fields.next() == Some("HTTP/1.1") && fields.next() == Some("200") {
                return Ok(());
            }
            return fail("Service is not ready");
        }
    }
    fail("Invalid readiness response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};

    #[test]
    fn readiness_requires_a_complete_success_status() {
        for response in [
            "HTTP/1.1 200 OK\r\n",
            "HTTP/1.1 503 Unavailable\r\n",
            "HTTP/1.1 2000 Invalid\r\n",
            "HTTP/1.1 200",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let worker = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 512];
                let count = stream.read(&mut request).unwrap();
                assert!(request[..count].starts_with(b"GET /readyz HTTP/1.1\r\n"));
                stream.write_all(response.as_bytes()).unwrap();
                thread::sleep(Duration::from_millis(20));
            });
            assert_eq!(
                check(address, Duration::from_secs(2)).is_ok(),
                response == "HTTP/1.1 200 OK\r\n"
            );
            worker.join().unwrap();
        }
    }
}

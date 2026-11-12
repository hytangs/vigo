//! Remove an unpublished City when the build is interrupted.
//!
//! The signal handler only writes the signal number to a pipe. A watcher
//! thread removes the registered directory, restores the default action and
//! raises the signal again, so the caller still sees how the build ended.
//! SIGKILL and crashes leave the directory; the next build removes it.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static TARGET: Mutex<Option<PathBuf>> = Mutex::new(None);
static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// After a termination signal, let the watcher finish: it removes the
/// unpublished City and ends the process with that signal. A compiler step
/// that fails because its files were removed must not exit first.
pub(crate) fn await_termination() {
    if INTERRUPTED.load(std::sync::atomic::Ordering::SeqCst) {
        loop {
            std::thread::park();
        }
    }
}

pub(crate) struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Register `directory` before it is created.
pub(crate) fn remove_on_termination(directory: &Path) -> Guard {
    *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = Some(directory.to_path_buf());
    #[cfg(unix)]
    unix::install();
    Guard
}

fn remove_target() {
    let target = TARGET.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(target) = target else {
        return;
    };
    // Compiler threads may still create files; retry until the tree is gone.
    for _ in 0..40 {
        match std::fs::remove_dir_all(&target) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::sync::Once;
    use std::sync::atomic::{AtomicI32, Ordering};

    static WRITE: AtomicI32 = AtomicI32::new(-1);
    static INSTALL: Once = Once::new();
    const SIGNALS: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

    extern "C" fn notify(signal: libc::c_int) {
        super::INTERRUPTED.store(true, Ordering::SeqCst);
        let byte = signal as u8;
        // SAFETY: write(2) is async-signal-safe; the descriptor stays open.
        unsafe {
            libc::write(
                WRITE.load(Ordering::Relaxed),
                (&byte as *const u8).cast(),
                1,
            );
        }
    }

    pub(super) fn install() {
        INSTALL.call_once(|| {
            let mut fds = [0 as libc::c_int; 2];
            // SAFETY: fds has room for both descriptors.
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return;
            }
            WRITE.store(fds[1], Ordering::Relaxed);
            let read = fds[0];
            std::thread::spawn(move || {
                let mut byte = 0u8;
                // SAFETY: reads one byte into a valid buffer.
                while unsafe { libc::read(read, (&mut byte as *mut u8).cast(), 1) } != 1 {}
                super::remove_target();
                let signal = libc::c_int::from(byte);
                // SAFETY: restoring the default action and re-raising ends
                // the process with the signal that interrupted it.
                unsafe {
                    libc::signal(signal, libc::SIG_DFL);
                    libc::raise(signal);
                }
                std::process::exit(128 + signal);
            });
            for signal in SIGNALS {
                // SAFETY: the handler is async-signal-safe.
                unsafe {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    action.sa_sigaction =
                        notify as extern "C" fn(libc::c_int) as libc::sighandler_t;
                    libc::sigemptyset(&mut action.sa_mask);
                    // Blocking reads and writes elsewhere resume after the
                    // handler instead of failing with EINTR.
                    action.sa_flags = libc::SA_RESTART;
                    libc::sigaction(signal, &action, std::ptr::null_mut());
                }
            }
        });
    }
}

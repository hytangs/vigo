//! Host memory and load, for planning concurrent compilation.

/// Installed physical memory (`os.totalmem()`).
pub(crate) fn memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        sysctl_u64(c"hw.memsize").unwrap_or(16 << 30)
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: sysconf has no preconditions.
        let (pages, size) = unsafe {
            (
                libc::sysconf(libc::_SC_PHYS_PAGES),
                libc::sysconf(libc::_SC_PAGESIZE),
            )
        };
        if pages > 0 && size > 0 {
            pages as u64 * size as u64
        } else {
            16 << 30
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        16 << 30
    }
}

/// Memory free now (`os.freemem()`).
pub(crate) fn available_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        // Like Linux's MemAvailable: free pages plus the inactive, speculative
        // and purgeable pages macOS reclaims without swapping. Free pages
        // alone stay near zero on a busy Mac.
        let mut info: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        // SAFETY: `info` holds HOST_VM_INFO64_COUNT integers.
        #[allow(deprecated)]
        let status = unsafe {
            libc::host_statistics64(
                libc::mach_host_self(),
                libc::HOST_VM_INFO64,
                (&raw mut info).cast(),
                &mut count,
            )
        };
        // SAFETY: sysconf has no preconditions.
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
        if status == libc::KERN_SUCCESS {
            let pages = u64::from(info.free_count)
                + u64::from(info.inactive_count)
                + u64::from(info.speculative_count)
                + u64::from(info.purgeable_count);
            pages * size
        } else {
            sysctl_u64(c"vm.page_free_count").unwrap_or(0) * size
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find_map(|line| line.strip_prefix("MemAvailable:"))
                    .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            })
            .map_or(0, |kib| kib * 1024)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        memory_bytes() / 2
    }
}

/// One, five and fifteen minute load averages (`os.loadavg()`).
pub(crate) fn load_average() -> [f64; 3] {
    #[cfg(unix)]
    {
        let mut load = [0.0f64; 3];
        // SAFETY: the buffer holds three samples.
        if unsafe { libc::getloadavg(load.as_mut_ptr(), 3) } == 3 {
            return load;
        }
    }
    [0.0; 3]
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
    let mut value = 0u64;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: value and size describe a writable buffer for the result.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    let value = if size == 4 {
        value & 0xffff_ffff
    } else {
        value
    };
    (status == 0).then_some(value)
}

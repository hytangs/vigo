//! Memory-mapped readers for the permanent prepared City layouts.
//! Files must remain immutable while a Snapshot is alive.
use crate::{FormatError, FormatResult as Result};
use memmap2::Mmap;
use serde_json::Value;
use std::{fs::File, io::Read, path::Path};

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(FormatError::invalid(message))
}

pub struct Snapshot {
    pub header: Value,
    bytes: Mmap,
    base: usize,
}
impl Snapshot {
    pub fn mapped_bytes(&self) -> usize {
        self.bytes.len()
    }
    // Parse large metadata directly into its native projection; unknown fields
    // are validated as JSON and skipped instead of retained as Value trees.
    pub fn open_with_metadata<T: serde::de::DeserializeOwned>(path: &Path) -> Result<(Self, T)> {
        #[derive(serde::Deserialize)]
        struct Envelope<T> {
            metadata: T,
            #[serde(flatten)]
            header: serde_json::Map<String, Value>,
        }
        let file = File::open(path)?;
        // Prepared City artifacts are immutable for the process lifetime.
        let bytes = unsafe { Mmap::map(&file)? };
        let (range, base) = portable_header(&bytes)?;
        let header = portable_metadata(&bytes, range)?;
        let parsed: Envelope<T> = serde_json::from_slice(&header)?;
        let image = Self {
            header: Value::Object(parsed.header),
            bytes,
            base,
        };
        image.validate_portable_arrays()?;
        Ok((image, parsed.metadata))
    }
    fn validate_portable_arrays(&self) -> Result<()> {
        if !self.base.is_multiple_of(8) {
            return fail("Unaligned routing snapshot payload");
        }
        let mut ranges = Vec::new();
        for (name, array) in self.header["arrays"]
            .as_object()
            .ok_or("Missing snapshot arrays")?
        {
            let kind = array["type"].as_str().ok_or("Missing array type")?;
            let size = match kind {
                "Uint8Array" => 1,
                "Uint32Array" | "Int32Array" => 4,
                "Float64Array" => 8,
                _ => return fail("Unsupported snapshot array type"),
            };
            let bytes = self.array(name, kind, size)?;
            let start = usize::try_from(array["offset"].as_u64().ok_or("Invalid array offset")?)?;
            ranges.push((start, bytes.len()));
        }
        // JSON object key order is immaterial. Zero-length arrays sharing an
        // offset precede a nonempty array at that offset.
        ranges.sort_unstable();
        let mut end = 0usize;
        for (start, length) in ranges {
            let aligned = end.checked_add(7).ok_or("Array alignment overflow")? / 8 * 8;
            if start != aligned {
                return fail("Overlapping or noncanonical snapshot arrays");
            }
            end = start.checked_add(length).ok_or("Array end overflow")?;
        }
        Ok(())
    }
    pub fn open(path: &Path, portable: bool) -> Result<Self> {
        let file = File::open(path)?;
        // City artifacts are immutable for the lifetime of the process.
        let bytes = unsafe { Mmap::map(&file)? };
        let (header, base) = if portable {
            let (range, base) = portable_header(&bytes)?;
            (
                serde_json::from_slice(&portable_metadata(&bytes, range)?)?,
                base,
            )
        } else {
            if bytes.len() < 4096 {
                return fail("Truncated street snapshot");
            }
            let s = std::str::from_utf8(&bytes[..4096])?.trim_matches(['\0', ' ', '\n', '\r']);
            let header: Value = serde_json::from_str(s)?;
            if header["byteLength"].as_u64() != Some(bytes.len() as u64) {
                return fail("Street snapshot size mismatch");
            }
            (header, 0)
        };
        Ok(Self {
            header,
            bytes,
            base,
        })
    }
    pub fn array(&self, name: &str, kind: &str, size: usize) -> Result<&[u8]> {
        let a = &self.header["arrays"][name];
        if a["type"] != kind {
            return fail(format!("Invalid snapshot array {name}"));
        }
        let start = usize::try_from(a["offset"].as_u64().ok_or("Invalid array offset")?)?
            .checked_add(self.base)
            .ok_or("Array offset overflow")?;
        let length = usize::try_from(a["length"].as_u64().ok_or("Invalid array length")?)?
            .checked_mul(size)
            .ok_or("Array length overflow")?;
        self.bytes
            .get(start..start.checked_add(length).ok_or("Array end overflow")?)
            .ok_or_else(|| "Array exceeds snapshot".into())
    }
    pub fn u32(&self, name: &str) -> Result<Vec<u32>> {
        Ok(self
            .array(name, "Uint32Array", 4)?
            .chunks_exact(4)
            .map(|x| u32::from_le_bytes(x.try_into().unwrap()))
            .collect())
    }
    pub fn f64(&self, name: &str) -> Result<Vec<f64>> {
        Ok(self
            .array(name, "Float64Array", 8)?
            .chunks_exact(8)
            .map(|x| f64::from_le_bytes(x.try_into().unwrap()))
            .collect())
    }
}

fn portable_header(bytes: &[u8]) -> Result<(std::ops::Range<usize>, usize)> {
    if bytes.len() < 16 || &bytes[..8] != b"VIGORS02" {
        return fail("Unsupported routing snapshot; rebuild City with VIGO 0.5.0 or later");
    }
    let len = u32::from_le_bytes(bytes[8..12].try_into()?) as usize;
    let base = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    if len > 512 * 1024 * 1024
        || len > bytes.len() - 16
        || base != (16 + len).div_ceil(8) * 8
        || base > bytes.len()
    {
        return fail("Invalid routing snapshot header");
    }
    Ok((16..16 + len, base))
}

fn portable_metadata(bytes: &[u8], range: std::ops::Range<usize>) -> Result<Vec<u8>> {
    // Bound expansion before parsing. Numeric arrays stay in their mmap;
    // only the compressed JSON header needs a temporary allocation.
    const LIMIT: u64 = 512 * 1024 * 1024;
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(&bytes[range])
        .take(LIMIT + 1)
        .read_to_end(&mut decoded)?;
    if decoded.len() as u64 > LIMIT {
        return fail("Routing snapshot metadata exceeds its size limit");
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(arrays: Value) -> Snapshot {
        let mut bytes = memmap2::MmapMut::map_anon(64).unwrap();
        bytes[16..20].copy_from_slice(&0x01020304_u32.to_le_bytes());
        Snapshot {
            header: serde_json::json!({"arrays": arrays}),
            bytes: bytes.make_read_only().unwrap(),
            base: 16,
        }
    }

    #[test]
    fn arrays_are_bounds_checked_and_little_endian() {
        let image = snapshot(serde_json::json!({
            "empty": {"type":"Uint8Array","offset":0,"length":0},
            "values": {"type":"Uint32Array","offset":0,"length":1}
        }));
        image.validate_portable_arrays().unwrap();
        assert_eq!(image.u32("values").unwrap(), [0x01020304]);
        assert_eq!(
            image.f64("values").unwrap_err().code,
            crate::FormatErrorCode::InvalidArtifact
        );
        for arrays in [
            serde_json::json!({"a":{"type":"Uint32Array","offset":0,"length":2},"b":{"type":"Uint8Array","offset":4,"length":1}}),
            serde_json::json!({"a":{"type":"Uint32Array","offset":0,"length":100}}),
            serde_json::json!({"a":{"type":"Float64Array","offset":u64::MAX,"length":1}}),
            serde_json::json!({"a":{"type":"Uint8Array","offset":1,"length":1}}),
        ] {
            assert_eq!(
                snapshot(arrays)
                    .validate_portable_arrays()
                    .unwrap_err()
                    .code,
                crate::FormatErrorCode::InvalidArtifact
            );
        }
    }
    #[test]
    fn compact_snapshot_header_preserves_payload_and_rejects_damage() {
        use std::io::Write;
        let metadata = br#"{"metadata":{"name":"synthetic"},"arrays":{}}"#;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(metadata).unwrap();
        let compressed = encoder.finish().unwrap();
        let base = (16 + compressed.len()).div_ceil(8) * 8;
        let mut bytes = vec![0u8; base];
        bytes[..8].copy_from_slice(b"VIGORS02");
        bytes[8..12].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(base as u32).to_le_bytes());
        bytes[16..16 + compressed.len()].copy_from_slice(&compressed);
        let (range, actual_base) = portable_header(&bytes).unwrap();
        assert_eq!(actual_base, base);
        assert_eq!(
            portable_metadata(&bytes, range.clone()).unwrap().as_slice(),
            metadata
        );
        bytes[range.end - 8] ^= 1;
        assert!(portable_metadata(&bytes, range).is_err());
        assert!(portable_header(&bytes[..15]).is_err());
        bytes[..8].copy_from_slice(b"VIGORS01");
        assert!(
            portable_header(&bytes)
                .unwrap_err()
                .to_string()
                .contains("rebuild")
        );
    }
}

//! Write the permanent VIGORS02 envelope without changing its numeric payload.
//! Array order is explicit: the published JavaScript reader visits descriptors
//! in insertion order, including zero-length arrays at a shared offset.
use crate::{FormatError, FormatResult};
use serde::{Serialize, Serializer, ser::SerializeMap};
use std::{collections::HashSet, io::Write};
use vigo_route::types::U8Buffer;

const MAXIMUM_HEADER_BYTES: usize = 512 * 1024 * 1024;

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableArray {
    pub name: String,
    pub kind: String,
    pub data: U8Buffer,
}

#[derive(Serialize)]
struct Descriptor<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    offset: usize,
    length: usize,
}
struct Layout<'a>(Vec<(&'a str, Descriptor<'a>)>);
impl Serialize for Layout<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, descriptor) in &self.0 {
            map.serialize_entry(name, descriptor)?;
        }
        map.end()
    }
}

fn align(value: usize) -> FormatResult<usize> {
    value
        .checked_add(7)
        .map(|n| n / 8 * 8)
        .ok_or_else(|| FormatError::invalid("Routing snapshot layout overflow"))
}

pub fn encode_routing_snapshot(
    metadata_json: Option<&str>,
    arrays: &[PortableArray],
) -> FormatResult<Vec<u8>> {
    if metadata_json.is_some_and(|json| json.len() > MAXIMUM_HEADER_BYTES) {
        return Err(FormatError::invalid(
            "Routing snapshot metadata exceeds its size limit.",
        ));
    }
    // Retain the caller's metadata JSON exactly, including number spelling,
    // object ordering and escaped source IDs. It is still validated as JSON.
    let metadata: Option<&serde_json::value::RawValue> =
        metadata_json.map(serde_json::from_str).transpose()?;
    let mut names = HashSet::new();
    let mut layout = Layout(Vec::with_capacity(arrays.len()));
    let mut size = 0usize;
    for array in arrays {
        let width = match array.kind.as_str() {
            "Uint8Array" => 1,
            "Uint32Array" | "Int32Array" => 4,
            "Float64Array" => 8,
            _ => {
                return Err(FormatError::invalid(format!(
                    "Unsupported snapshot array: {}",
                    array.name
                )));
            }
        };
        if !names.insert(array.name.as_str()) || !array.data.len().is_multiple_of(width) {
            return Err(FormatError::invalid(format!(
                "Invalid snapshot array: {}",
                array.name
            )));
        }
        layout.0.push((
            &array.name,
            Descriptor {
                kind: &array.kind,
                offset: size,
                length: array.data.len() / width,
            },
        ));
        size = align(
            size.checked_add(array.data.len())
                .ok_or("Routing snapshot layout overflow")?,
        )?;
    }
    #[derive(Serialize)]
    struct Header<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<&'a serde_json::value::RawValue>,
        arrays: &'a Layout<'a>,
    }
    let raw_header = serde_json::to_vec(&Header {
        metadata,
        arrays: &layout,
    })?;
    if raw_header.len() > MAXIMUM_HEADER_BYTES {
        return Err(FormatError::invalid(
            "Routing snapshot metadata exceeds its size limit.",
        ));
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&raw_header)?;
    let header = encoder.finish()?;
    let data_offset = align(
        16usize
            .checked_add(header.len())
            .ok_or("Routing snapshot layout overflow")?,
    )?;
    let header_length = u32::try_from(header.len())?;
    let encoded_offset = u32::try_from(data_offset)?;
    let length = data_offset
        .checked_add(size)
        .ok_or("Routing snapshot layout overflow")?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(length)
        .map_err(|e| FormatError::invalid(format!("Routing snapshot allocation: {e}")))?;
    output.resize(length, 0);
    output[..8].copy_from_slice(b"VIGORS02");
    output[8..12].copy_from_slice(&header_length.to_le_bytes());
    output[12..16].copy_from_slice(&encoded_offset.to_le_bytes());
    output[16..16 + header.len()].copy_from_slice(&header);
    for (array, (_, descriptor)) in arrays.iter().zip(&layout.0) {
        let start = data_offset + descriptor.offset;
        output[start..start + array.data.len()].copy_from_slice(&array.data);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn preserves_descriptor_order_metadata_and_exact_payload() {
        let metadata = r#"{"source":"入口","number":1e3,"zero":-0}"#;
        let array = |name: &str, kind: &str, data: Vec<u8>| PortableArray {
            name: name.into(),
            kind: kind.into(),
            data: data.into(),
        };
        let arrays = [
            array("z", "Uint8Array", vec![9]),
            array("empty", "Uint8Array", vec![]),
            array("a", "Uint32Array", 0x01020304_u32.to_le_bytes().to_vec()),
        ];
        let encoded = encode_routing_snapshot(Some(metadata), &arrays).unwrap();
        let length = u32::from_le_bytes(encoded[8..12].try_into().unwrap()) as usize;
        let offset = u32::from_le_bytes(encoded[12..16].try_into().unwrap()) as usize;
        let mut header = String::new();
        flate2::read::GzDecoder::new(&encoded[16..16 + length])
            .read_to_string(&mut header)
            .unwrap();
        assert!(header.starts_with(&format!("{{\"metadata\":{metadata},\"arrays\":")));
        assert!(header.find("\"z\"").unwrap() < header.find("\"empty\"").unwrap());
        assert!(header.find("\"empty\"").unwrap() < header.find("\"a\"").unwrap());
        assert_eq!(
            &encoded[offset..offset + 16],
            &[9, 0, 0, 0, 0, 0, 0, 0, 4, 3, 2, 1, 0, 0, 0, 0]
        );
        assert_eq!(
            encoded,
            encode_routing_snapshot(Some(metadata), &arrays).unwrap()
        );
    }

    #[test]
    fn rejects_invalid_json_duplicate_names_and_partial_elements() {
        assert!(encode_routing_snapshot(Some("{"), &[]).is_err());
        for (name, kind, data) in [("x", "Float64Array", vec![1]), ("x", "Unknown", vec![])] {
            assert!(
                encode_routing_snapshot(
                    Some("{}"),
                    &[PortableArray {
                        name: name.into(),
                        kind: kind.into(),
                        data: data.into()
                    }]
                )
                .is_err()
            );
        }
        let duplicate = || PortableArray {
            name: "x".into(),
            kind: "Uint8Array".into(),
            data: vec![].into(),
        };
        assert!(encode_routing_snapshot(Some("{}"), &[duplicate(), duplicate()]).is_err());
    }
}

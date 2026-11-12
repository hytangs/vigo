//! OSM tags with the JavaScript object semantics `wayTags` produced.

use crate::pbf::{Block, DenseNodes};
use crate::{Error, Result};

#[derive(Clone, Default, Debug)]
pub struct Tags<'a> {
    entries: Vec<(&'a str, &'a str)>,
}

impl<'a> Tags<'a> {
    fn assign(&mut self, key: &'a str, value: &'a str) {
        // `tags.__proto__ = string` does not create a property.
        if key == "__proto__" {
            return;
        }
        match self.entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    /// `wayTags(entity, strings)` for nodes, ways and relations.
    pub fn from_keys(block: &'a Block, keys: &[u32], vals: &[u32]) -> Result<Self> {
        let mut tags = Tags {
            entries: Vec::with_capacity(keys.len()),
        };
        for (&key, &value) in keys.iter().zip(vals) {
            match (block.string(key), block.string(value)) {
                (Some(key), Some(value)) => tags.assign(key, value),
                _ => {
                    return Err(Error::new(
                        "OSM PBF way references an out-of-range string-table entry.",
                    ));
                }
            }
        }
        Ok(tags)
    }

    /// `denseNodeTags(dense, index, strings)`.
    pub fn from_dense(block: &'a Block, dense: &DenseNodes, index: usize) -> Result<Self> {
        let mut tags = Tags::default();
        let (start, end) = (
            dense.tag_offsets[index] as usize,
            dense.tag_offsets[index + 1] as usize,
        );
        let mut offset = start;
        while offset + 1 < end {
            match (
                block.string(dense.keys_vals[offset]),
                block.string(dense.keys_vals[offset + 1]),
            ) {
                (Some(key), Some(value)) => tags.assign(key, value),
                _ => {
                    return Err(Error::new(
                        "OSM PBF node references an out-of-range string-table entry.",
                    ));
                }
            }
            offset += 2;
        }
        Ok(tags)
    }

    pub fn get(&self, key: &str) -> Option<&'a str> {
        self.entries
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    /// Property assignment.
    pub fn set(&mut self, key: &'a str, value: &'a str) {
        self.assign(key, value);
    }

    /// `delete tags[key]`.
    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|(name, _)| *name != key);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'a str, &'a str)> + '_ {
        self.entries.iter().copied()
    }

    /// A non-empty value, as JavaScript truthiness of `tags[key]`.
    pub fn truthy(&self, key: &str) -> bool {
        self.get(key).is_some_and(|value| !value.is_empty())
    }
}

#[cfg(test)]
impl<'a> Tags<'a> {
    /// Tags from literal pairs in object-literal order, for rule tests.
    pub fn of(pairs: &[(&'a str, &'a str)]) -> Self {
        let mut tags = Tags::default();
        for &(key, value) in pairs {
            tags.assign(key, value);
        }
        tags
    }
}

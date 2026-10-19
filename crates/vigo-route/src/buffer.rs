//! Numeric buffers with explicit ownership. Adapters can retain an existing
//! allocation without copying it or introducing a transport dependency here.
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};

pub enum Buffer<T> {
    Owned(Vec<T>),
    External(Arc<dyn AsRef<[T]> + Send + Sync>),
}

impl<T> Buffer<T> {
    pub fn from_owner(owner: impl AsRef<[T]> + Send + Sync + 'static) -> Self {
        Self::External(Arc::new(owner))
    }

    pub fn is_external(&self) -> bool {
        matches!(self, Self::External(_))
    }

    /// Allocation charged to the owner; external storage is charged in full.
    pub fn capacity(&self) -> usize {
        match self {
            Self::Owned(v) => v.capacity(),
            Self::External(v) => v.as_ref().as_ref().len(),
        }
    }
}

impl<T: Clone> Buffer<T> {
    pub fn into_vec(self) -> Vec<T> {
        match self {
            Self::Owned(v) => v,
            Self::External(v) => v.as_ref().as_ref().to_vec(),
        }
    }
}

impl<T> From<Vec<T>> for Buffer<T> {
    fn from(value: Vec<T>) -> Self {
        Self::Owned(value)
    }
}
impl<T> Default for Buffer<T> {
    fn default() -> Self {
        Self::Owned(Vec::new())
    }
}
impl<T> Deref for Buffer<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        match self {
            Self::Owned(v) => v,
            Self::External(v) => v.as_ref().as_ref(),
        }
    }
}
impl<T> AsRef<[T]> for Buffer<T> {
    fn as_ref(&self) -> &[T] {
        self
    }
}
impl<T: Clone> DerefMut for Buffer<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        if let Self::External(v) = self {
            *self = Self::Owned(v.as_ref().as_ref().to_vec());
        }
        match self {
            Self::Owned(v) => v,
            Self::External(_) => unreachable!(),
        }
    }
}
impl<T: Clone> Clone for Buffer<T> {
    fn clone(&self) -> Self {
        match self {
            Self::Owned(v) => Self::Owned(v.clone()),
            Self::External(v) => Self::External(v.clone()),
        }
    }
}
impl<'a, T> IntoIterator for &'a Buffer<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
impl<T: std::fmt::Debug> std::fmt::Debug for Buffer<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_ref().fmt(f)
    }
}
impl<T: PartialEq> PartialEq for Buffer<T> {
    fn eq(&self, other: &Self) -> bool {
        self.as_ref() == other.as_ref()
    }
}
impl<T: serde::Serialize> serde::Serialize for Buffer<T> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.as_ref().serialize(serializer)
    }
}
impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for Buffer<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Vec::<T>::deserialize(deserializer).map(Self::Owned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_owner_is_retained_and_mutation_detaches() {
        struct Owner(Arc<Vec<u32>>);
        impl AsRef<[u32]> for Owner {
            fn as_ref(&self) -> &[u32] {
                &self.0
            }
        }
        let owner = Arc::new(vec![1, 2, 3]);
        let ptr = owner.as_ptr();
        let mut buffer = Buffer::from_owner(Owner(owner.clone()));
        let shared = buffer.clone();
        assert_eq!(buffer.as_ptr(), ptr);
        buffer[0] = 9;
        assert_eq!(owner[0], 1);
        assert_eq!(shared.as_ptr(), ptr);
        drop(owner);
        assert_eq!(shared.as_ref(), &[1, 2, 3]);
        assert_eq!(buffer.into_vec(), vec![9, 2, 3]);
    }
    #[test]
    fn owned_output_moves_without_a_copy() {
        let values = vec![1_u32, 2, 3];
        let ptr = values.as_ptr();
        let returned = Buffer::from(values).into_vec();
        assert_eq!(returned.as_ptr(), ptr);
    }
}

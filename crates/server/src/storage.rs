//! Where attachment bytes live: local disk (`<data dir>/attachments/<id>`, the default), an S3-compatible bucket
//! (`VOKKO_STORAGE=s3`) or memory (tests). Every read, write, copy and delete of an attachment file goes through `Storage`;
//! rows, keys and access rules stay in the database and the routes.
pub mod s3;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use futures_util::future::BoxFuture;

use crate::config::DotEnv;

pub use s3::S3Config;

/// A stored file ready to stream back to a client.
pub struct Object {
    pub length: u64,
    pub body: Body,
}

/// Response headers a presigned URL asks the bucket to send, so a redirected download looks like a proxied one.
pub struct Presign<'a> {
    pub content_type: &'a str,
    pub disposition: &'a str,
}

pub trait Storage: Send + Sync {
    fn put(&self, id: i64, bytes: Bytes) -> BoxFuture<'_, io::Result<()>>;
    /// Stores the file at `path` (a staging file; it may be moved, and the caller removes it if it is still there).
    /// The default reads it into memory and calls `put`.
    fn put_file<'a>(&'a self, id: i64, path: &'a Path) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            let bytes = tokio::fs::read(path).await?;
            self.put(id, Bytes::from(bytes)).await
        })
    }
    /// `ErrorKind::NotFound` when there is no such file.
    fn open(&self, id: i64) -> BoxFuture<'_, io::Result<Object>>;
    /// The whole file in memory (small files only: stickers).
    fn read(&self, id: i64) -> BoxFuture<'_, io::Result<Bytes>>;
    fn copy(&self, from: i64, to: i64) -> BoxFuture<'_, io::Result<()>>;
    /// Removing a file that is already gone succeeds.
    fn delete(&self, id: i64) -> BoxFuture<'_, io::Result<()>>;
    /// Deletes are cheap enough to await inside a request (local disk, memory); remote backends delete in the background.
    fn deletes_inline(&self) -> bool {
        false
    }
    /// A short-lived direct download URL, when the backend is configured to hand those out instead of proxying.
    fn presigned_url(&self, _id: i64, _presign: &Presign<'_>) -> Option<String> {
        None
    }
}

/// `VOKKO_STORAGE`: `local` (default) or `s3`.
#[derive(Clone, Debug)]
pub enum StorageConfig {
    Local,
    S3(S3Config),
    /// In-process only (tests); not selectable from the environment.
    Memory,
}

impl StorageConfig {
    pub fn from_env(env: &DotEnv) -> Result<Self, String> {
        match env.get("VOKKO_STORAGE").map(|value| value.trim().to_ascii_lowercase()).as_deref() {
            None | Some("local") | Some("") => Ok(Self::Local),
            Some("s3") => S3Config::from_env(env).map(Self::S3),
            Some(other) => Err(format!("VOKKO_STORAGE must be `local` or `s3`, got {other}")),
        }
    }
}

pub fn build(config: &StorageConfig, data_dir: &std::path::Path) -> Arc<dyn Storage> {
    match config {
        StorageConfig::Local => Arc::new(LocalStorage::new(data_dir.join("attachments"))),
        StorageConfig::S3(s3) => Arc::new(s3::S3Storage::new(s3.clone())),
        StorageConfig::Memory => Arc::new(MemoryStorage::default()),
    }
}

/// One file per attachment id under `dir`.
pub struct LocalStorage {
    dir: PathBuf,
}

impl LocalStorage {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, id: i64) -> PathBuf {
        self.dir.join(id.to_string())
    }
}

impl Storage for LocalStorage {
    fn deletes_inline(&self) -> bool {
        true
    }

    fn put(&self, id: i64, bytes: Bytes) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            tokio::fs::create_dir_all(&self.dir).await?;
            tokio::fs::write(self.path(id), &bytes).await
        })
    }

    /// A rename when the staging file is on the same filesystem, else a copy.
    fn put_file<'a>(&'a self, id: i64, path: &'a Path) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            tokio::fs::create_dir_all(&self.dir).await?;
            let target = self.path(id);
            if tokio::fs::rename(path, &target).await.is_ok() {
                return Ok(());
            }
            tokio::fs::copy(path, &target).await.map(|_| ())
        })
    }

    fn open(&self, id: i64) -> BoxFuture<'_, io::Result<Object>> {
        Box::pin(async move {
            let file = tokio::fs::File::open(self.path(id)).await?;
            let length = file.metadata().await?.len();
            Ok(Object { length, body: Body::from_stream(tokio_util::io::ReaderStream::new(file)) })
        })
    }

    fn read(&self, id: i64) -> BoxFuture<'_, io::Result<Bytes>> {
        Box::pin(async move { tokio::fs::read(self.path(id)).await.map(Bytes::from) })
    }

    /// A hard link when the filesystem allows it (snapshots share the bytes), else a full copy.
    fn copy(&self, from: i64, to: i64) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            tokio::fs::create_dir_all(&self.dir).await?;
            let (from, to) = (self.path(from), self.path(to));
            if tokio::fs::hard_link(&from, &to).await.is_ok() {
                return Ok(());
            }
            tokio::fs::copy(&from, &to).await.map(|_| ())
        })
    }

    fn delete(&self, id: i64) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            match tokio::fs::remove_file(self.path(id)).await {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        })
    }
}

/// Files in a map; lost on restart. Tests use it to exercise the routes without a disk or a bucket.
#[derive(Default)]
pub struct MemoryStorage {
    files: Mutex<HashMap<i64, Bytes>>,
}

impl MemoryStorage {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, Bytes>> {
        self.files.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn get(&self, id: i64) -> io::Result<Bytes> {
        self.lock().get(&id).cloned().ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }
}

impl Storage for MemoryStorage {
    fn deletes_inline(&self) -> bool {
        true
    }

    fn put(&self, id: i64, bytes: Bytes) -> BoxFuture<'_, io::Result<()>> {
        self.lock().insert(id, bytes);
        Box::pin(async { Ok(()) })
    }

    fn open(&self, id: i64) -> BoxFuture<'_, io::Result<Object>> {
        let found = self.get(id).map(|bytes| Object { length: bytes.len() as u64, body: Body::from(bytes) });
        Box::pin(async move { found })
    }

    fn read(&self, id: i64) -> BoxFuture<'_, io::Result<Bytes>> {
        let found = self.get(id);
        Box::pin(async move { found })
    }

    fn copy(&self, from: i64, to: i64) -> BoxFuture<'_, io::Result<()>> {
        let copied = self.get(from).map(|bytes| {
            self.lock().insert(to, bytes);
        });
        Box::pin(async move { copied })
    }

    fn delete(&self, id: i64) -> BoxFuture<'_, io::Result<()>> {
        self.lock().remove(&id);
        Box::pin(async { Ok(()) })
    }
}

/// Default and upper bound of `VOKKO_S3_PRESIGN_TTL_SECS` (SigV4 allows at most 7 days).
pub const DEFAULT_PRESIGN_TTL: Duration = Duration::from_secs(300);
pub const MAX_PRESIGN_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    async fn exercise(storage: &dyn Storage) {
        storage.put(1, Bytes::from_static(b"hello")).await.expect("put");
        assert_eq!(storage.read(1).await.expect("read"), Bytes::from_static(b"hello"));
        let object = storage.open(1).await.expect("open");
        assert_eq!(object.length, 5);
        let body = axum::body::to_bytes(object.body, usize::MAX).await.expect("body");
        assert_eq!(&body[..], b"hello");
        storage.copy(1, 2).await.expect("copy");
        storage.delete(1).await.expect("delete");
        assert_eq!(storage.read(1).await.map_err(|error| error.kind()).err(), Some(io::ErrorKind::NotFound));
        assert_eq!(storage.read(2).await.expect("the copy survives"), Bytes::from_static(b"hello"));
        storage.delete(1).await.expect("deleting a missing file succeeds");
        assert!(storage.copy(1, 3).await.is_err(), "copying a missing file fails");
        assert_eq!(storage.open(9).await.err().map(|error| error.kind()), Some(io::ErrorKind::NotFound));
    }

    #[tokio::test]
    async fn memory_backend() {
        exercise(&MemoryStorage::default()).await;
    }

    #[tokio::test]
    async fn local_backend() {
        let dir = std::env::temp_dir().join(format!("vokko-storage-{}", crate::auth::random_hex(6)));
        exercise(&LocalStorage::new(dir.join("attachments"))).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn storage_selection() {
        let env = |pairs: &[(&str, &str)]| DotEnv::from_pairs(pairs);
        assert!(matches!(StorageConfig::from_env(&env(&[])), Ok(StorageConfig::Local)));
        assert!(matches!(StorageConfig::from_env(&env(&[("VOKKO_STORAGE", "local")])), Ok(StorageConfig::Local)));
        assert!(StorageConfig::from_env(&env(&[("VOKKO_STORAGE", "ftp")])).is_err());
        assert!(StorageConfig::from_env(&env(&[("VOKKO_STORAGE", "s3")])).is_err(), "s3 needs a bucket, endpoint and keys");
    }
}

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

/// Tracks synced files with mtime/size/hash in a local SQLite database.
pub struct FileTracker {
    conn: Connection,
}

pub type FileRecord = (f64, i64, String); // (mtime, size, sha256hex)

impl FileTracker {
    pub fn open(db_path: &PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;

        // Migrate: recreate if hash column missing
        let has_hash = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('synced_files') WHERE name='hash'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if !has_hash {
            conn.execute_batch("DROP TABLE IF EXISTS synced_files")?;
        }

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS synced_files (
                 path  TEXT PRIMARY KEY,
                 mtime REAL,
                 size  INTEGER,
                 hash  TEXT
             );
             CREATE TABLE IF NOT EXISTS metadata (
                 key   TEXT PRIMARY KEY,
                 value TEXT
             );",
        )?;

        Ok(Self { conn })
    }

    pub fn get_synced_files(&self) -> Result<HashMap<String, FileRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, mtime, size, hash FROM synced_files")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, f64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row?;
            map.insert(k, v);
        }
        Ok(map)
    }

    pub fn update_files(&self, files: &[(String, f64, i64, String)]) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "INSERT OR REPLACE INTO synced_files (path, mtime, size, hash) VALUES (?1,?2,?3,?4)",
        )?;
        for (path, mtime, size, hash) in files {
            stmt.execute(rusqlite::params![path, mtime, size, hash])?;
        }
        Ok(())
    }

    pub fn remove_files(&self, paths: &[String]) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("DELETE FROM synced_files WHERE path = ?1")?;
        for path in paths {
            stmt.execute([path])?;
        }
        Ok(())
    }

    pub fn get_metadata(&self, key: &str) -> Result<Option<String>> {
        let v = self
            .conn
            .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(v)
    }

    pub fn set_metadata(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
            [key, value],
        )?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.conn
            .execute_batch("DELETE FROM synced_files; DELETE FROM metadata;")?;
        Ok(())
    }
}

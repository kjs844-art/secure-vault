use rusqlite::Connection;

use crate::StoreLockV1;

/// A locked writable handle for the synthetic-only ciphertext store.
pub struct SyntheticWritableStoreV1 {
    pub(crate) connection: Connection,
    #[allow(dead_code, reason = "the owned guard enforces the store lock lifetime")]
    pub(crate) lock: StoreLockV1,
    pub(crate) preservation_latched: bool,
    #[cfg(test)]
    pub(crate) sql_access_count: usize,
}

impl SyntheticWritableStoreV1 {
    pub(crate) fn from_initialized(connection: Connection, lock: StoreLockV1) -> Self {
        Self {
            connection,
            lock,
            preservation_latched: false,
            #[cfg(test)]
            sql_access_count: 0,
        }
    }
}

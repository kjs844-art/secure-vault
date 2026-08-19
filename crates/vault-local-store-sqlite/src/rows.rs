//! Bounded, untrusted row values.  This module never sees a SQLite handle.

pub(crate) const MAX_REVISIONS: usize = 10_000;
pub(crate) const MAX_HEADS: usize = 5_000;
pub(crate) const MAX_CONFLICTS: usize = 5_000;
pub(crate) const MAX_TOTAL_REVISION_ENVELOPE_BYTES: usize = 128 * 1024 * 1024;

pub struct UntrustedStoredRevisionV1<'row> {
    pub(crate) record_id: &'row [u8],
    pub(crate) revision_id: &'row [u8],
    pub(crate) wire_version: i64,
    pub(crate) suite_id: i64,
    pub(crate) key_epoch: i64,
    pub(crate) padding_bucket: i64,
    pub(crate) envelope: &'row [u8],
}

impl UntrustedStoredRevisionV1<'_> {
    pub fn record_id(&self) -> &[u8] {
        self.record_id
    }
    pub fn revision_id(&self) -> &[u8] {
        self.revision_id
    }
    pub fn envelope(&self) -> &[u8] {
        self.envelope
    }
}

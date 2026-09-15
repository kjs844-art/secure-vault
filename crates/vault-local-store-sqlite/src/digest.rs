//! Exact logical digest framing for the read-only to writable handoff.

use blake3::Hasher;

pub(crate) struct LogicalDigestV1(Hasher);

impl LogicalDigestV1 {
    pub(crate) fn new() -> Self {
        let mut hasher = Hasher::new();
        hasher.update(b"SVLT-LOCAL-DIGEST-V1");
        Self(hasher)
    }

    pub(crate) fn table(&mut self, tag: u8) {
        self.0.update(&[0x54, tag]);
    }
    pub(crate) fn end_table(&mut self) {
        self.0.update(&[0x45]);
    }
    pub(crate) fn row(&mut self) {
        self.0.update(&[0x52]);
    }
    pub(crate) fn integer(&mut self, ordinal: u8, value: i64) {
        self.field(ordinal, 0x01, &value.to_be_bytes());
    }
    pub(crate) fn blob(&mut self, ordinal: u8, value: &[u8]) {
        self.field(ordinal, 0x02, value);
    }
    pub(crate) fn null(&mut self, ordinal: u8) {
        self.field(ordinal, 0x00, &[]);
    }
    pub(crate) fn finish(self) -> [u8; 32] {
        *self.0.finalize().as_bytes()
    }

    fn field(&mut self, ordinal: u8, kind: u8, value: &[u8]) {
        self.0.update(&[ordinal, kind]);
        self.0.update(&(value.len() as u64).to_be_bytes());
        self.0.update(value);
    }
}

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VfsProbeErrorCodeV1 {
    SharingViolation,
    Io,
    Protocol,
    UnsupportedPlatform,
}

pub struct VfsProbeErrorV1 {
    code: VfsProbeErrorCodeV1,
    os_code: Option<i32>,
}

impl VfsProbeErrorV1 {
    pub const fn code(&self) -> VfsProbeErrorCodeV1 {
        self.code
    }

    pub const fn os_code(&self) -> Option<i32> {
        self.os_code
    }

    pub(crate) const fn new(code: VfsProbeErrorCodeV1, os_code: Option<i32>) -> Self {
        Self { code, os_code }
    }

    pub(crate) fn from_io(error: &std::io::Error) -> Self {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        let os_code = error.raw_os_error();
        let code = if os_code == Some(ERROR_SHARING_VIOLATION) {
            VfsProbeErrorCodeV1::SharingViolation
        } else {
            VfsProbeErrorCodeV1::Io
        };
        Self::new(code, os_code)
    }

    pub const fn protocol() -> Self {
        Self::new(VfsProbeErrorCodeV1::Protocol, None)
    }
}

impl fmt::Display for VfsProbeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.code {
            VfsProbeErrorCodeV1::SharingViolation => "file sharing policy rejected access",
            VfsProbeErrorCodeV1::Io => "feasibility input/output failure",
            VfsProbeErrorCodeV1::Protocol => "feasibility protocol failure",
            VfsProbeErrorCodeV1::UnsupportedPlatform => "feasibility platform unsupported",
        })
    }
}

impl fmt::Debug for VfsProbeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VfsProbeErrorV1")
            .field("code", &self.code)
            .field("os_code", &self.os_code)
            .finish()
    }
}

impl std::error::Error for VfsProbeErrorV1 {}

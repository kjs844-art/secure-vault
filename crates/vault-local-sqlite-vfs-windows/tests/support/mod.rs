#![cfg(windows)]
#![cfg(feature = "feasibility-probe")]

use std::io::{BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use vault_local_sqlite_vfs_windows::VfsProbeErrorV1;
use vault_local_sqlite_vfs_windows::probe_protocol::{read_frame_v1, write_frame_v1};
use windows_sys::Win32::Foundation::{GetLastError, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

const CHILD_TIMEOUT_MS: u32 = 20_000;

pub struct FramedChildV1 {
    child: Option<Child>,
    stdin: ChildStdin,
    frames: std::sync::mpsc::Receiver<Result<String, VfsProbeErrorV1>>,
}

impl FramedChildV1 {
    pub fn spawn(path: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vault-vfs-feasibility-child"))
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|error| {
                panic!(
                    "INCONCLUSIVE_MAPPING_GATE:child_spawn:os={:?}",
                    error.raw_os_error()
                )
            });
        let stdin = child
            .stdin
            .take()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_child_stdin"));
        let stdout = child
            .stdout
            .take()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_child_stdout"));
        let (sender, frames) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = read_frame_v1(&mut reader);
                let terminal = frame.is_err();
                if sender.send(frame).is_err() {
                    break;
                }
                if terminal {
                    break;
                }
            }
        });
        Self {
            child: Some(child),
            stdin,
            frames,
        }
    }

    pub fn send(&mut self, frame: &str) {
        write_frame_v1(&mut self.stdin, frame).unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_send:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            )
        });
    }

    pub fn expect(&self, expected: &str) {
        let received = self
            .frames
            .recv_timeout(std::time::Duration::from_millis(u64::from(
                CHILD_TIMEOUT_MS,
            )))
            .unwrap_or_else(|error| panic!("INCONCLUSIVE_MAPPING_GATE:child_frame_wait:{error:?}"));
        let observed = received.unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_frame_read:code={:?}:os={:?}",
                error.code(),
                error.os_code()
            )
        });
        assert_eq!(
            observed, expected,
            "INCONCLUSIVE_MAPPING_GATE:child_frame_mismatch"
        );
    }

    pub fn finish_success(mut self) {
        self.stdin.flush().unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_flush:os={:?}",
                error.raw_os_error()
            )
        });
        let child = self
            .child
            .as_mut()
            .unwrap_or_else(|| panic!("INCONCLUSIVE_MAPPING_GATE:missing_live_child"));
        let wait = unsafe { WaitForSingleObject(child.as_raw_handle(), CHILD_TIMEOUT_MS) };
        match wait {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_timeout");
            }
            WAIT_FAILED => {
                let os_code = unsafe { GetLastError() };
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_wait_failed:os={os_code}");
            }
            other => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("INCONCLUSIVE_MAPPING_GATE:child_wait_unexpected:wait={other}");
            }
        }
        let status = child.wait().unwrap_or_else(|error| {
            panic!(
                "INCONCLUSIVE_MAPPING_GATE:child_wait_collect:os={:?}",
                error.raw_os_error()
            )
        });
        assert!(
            status.success(),
            "INCONCLUSIVE_MAPPING_GATE:child_exit:code={:?}",
            status.code()
        );
        self.child = None;
    }
}

impl Drop for FramedChildV1 {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

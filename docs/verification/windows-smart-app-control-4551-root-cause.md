# Windows Smart App Control 4551 Root-Cause Record

Date: 2026-08-31 (Asia/Seoul)

Status: root cause identified; no policy change; no test rerun; Phase 0A remains `Inconclusive`

## Scope

This record explains why the mandatory ordinary Rust suite for
`vault-local-sqlite-vfs-windows` exited `101` with OS error `4551` on the pinned
Windows host. It does not change the Windows security policy, approve a
workaround, rerun the one-time explicit hard gate, or authorize store/real-Secret
integration.

## Conclusion

The direct blocker is Windows Smart App Control in enforcement mode. The active
`VerifiedAndReputableDesktop` Code Integrity policy rejected an unsigned Rust
test executable because it did not meet the requested Enterprise signing level.

This is not evidence of a Rust source defect in the feasibility crate. It is also
not evidence that the ordinary suite would pass once execution is allowed. The
suite still must run successfully before the Phase 0A checkpoint can change.

## Authoritative local evidence

### Exact block event

The `Microsoft-Windows-CodeIntegrity/Operational` log contains enforcement event
`3077`, paired with event `3033`, for the failed ordinary-suite executable:

| Field | Observed value |
|---|---|
| Time | `2026-08-29 17:42:17/18 +09:00`, repeated at `17:48:59` |
| Parent process | Rust `cargo.exe` from toolchain `1.95.0-x86_64-pc-windows-msvc` |
| Blocked file | `target/debug/deps/vault_local_sqlite_vfs_windows-386a00a316a81043.exe` |
| Event | `3077` enforcement block; companion `3033` signing failure |
| Correlation | Activity ID `{59c6c6dd-3684-0002-f060-43658436dd01}`; records `24016`-`24020` |
| Policy name | `VerifiedAndReputableDesktop` |
| Policy GUID | `{0283ac0f-fff1-49ae-ada1-8a933130cad6}` |
| Policy version ID | `27555.1000.240208` |
| Requested signing level | `2` |
| Validated signing level | `1` |
| Status | `0xc0e90002` |
| Event SHA-256 flat hash | `05954EC044D4CBEAF3A212199B9D42CF619AAF23D6492416336AA03A437EDF32` |

The `3077` message states that the file did not meet Enterprise signing-level
requirements or violated the Code Integrity policy.

### Same-file proof

`Get-FileHash -Algorithm SHA256` on the retained blocked executable returned the
same SHA-256 value as the event's flat hash:

```text
05954EC044D4CBEAF3A212199B9D42CF619AAF23D6492416336AA03A437EDF32
```

`Get-AuthenticodeSignature` returned `NotSigned` with no signer certificate. The
file has only its normal `:$DATA` stream, so no Mark-of-the-Web stream was present.
The block therefore binds to this exact local build artifact and is not explained
by a downloaded-file zone marker.

Correlated Code Integrity event `3089` independently reports
`TotalSignatureCount = 0`, `PublisherName = Unknown`, and
`ValidatedSigningLevel = 0` for the same Activity ID.

A read-only ten-assertion cross-check of the event, policy identifiers, signing
levels, status, file hash, signature status, and activation event returned
`all_pass = true`.

### Active-policy proof

Code Integrity activation event `3099` records the same policy name, GUID, and
policy hash as the `3077` block. The local Code Integrity policy registry reports
`VerifiedAndReputablePolicyState = 1`, and the corresponding `.cip` file is present
under the active Code Integrity policy directory.

`CiTool -lp -json` returned access denied even when requested through the available
elevated execution boundary. This does not weaken the event-log evidence and is
recorded rather than bypassed.

### Pattern evidence

The same policy also blocked other newly built Rust test executables, including a
`platform_contract` executable and an unrelated `vault-crypto` test. This shows a
host-level executable-trust pattern rather than a failure unique to one crate.

The explicit `actual_handle_feasibility` artifact is also unsigned, but there is
no matching block event for its recorded successful run. Smart App Control can use
cloud reputation as well as trusted signatures, so an unsigned artifact being
allowed once does not establish deterministic future execution. No stronger reason
for that one allow decision is inferred from the available logs.

## Root-cause chain

```text
cargo test builds a new Rust test EXE
  -> EXE has no trusted Authenticode signature
  -> Smart App Control enforcement evaluates the new hash/reputation
  -> VerifiedAndReputableDesktop requests Enterprise signing level 2
  -> artifact validates at level 1
  -> Code Integrity event 3077 + status 0xc0e90002
  -> Windows returns os error 4551 to Cargo
  -> ordinary suite exits 101 before its library tests run
```

## Supported options and security effect

| Option | Security effect | Does it satisfy the current pinned-host gate? |
|---|---|---|
| Keep Smart App Control on and introduce a trusted RSA code-signing pipeline for every generated test EXE | Preserves host enforcement, but requires a trusted provider, deterministic post-build signing, and signature verification | Potentially, only after a separately reviewed plan amends the exact artifact/command contract; no suitable certificate or pipeline is currently configured |
| Submit the exact synthetic-only EXE hash/file to Microsoft Security Intelligence for Smart App Control review | Preserves host policy and source bytes, but the reputation decision and timing are nondeterministic and every rebuild creates a new hash | Only if the exact unchanged artifact later becomes allowed and the exact ordinary suite exits `0`; submission or a clean verdict alone is not gate evidence. No file was submitted in this session |
| Run the ordinary suite on a dedicated Windows development VM or hosted Windows CI runner where unsigned test executables are permitted | Preserves this physical host; provides useful build/test evidence | No. It is a different host unless the approved plan is revised to accept that environment |
| Turn Smart App Control off | Allows unsigned local development artifacts but weakens system-wide execution control; Smart App Control has no per-app allow switch | No action authorized. This run does not change or recommend weakening the host policy |
| Return to the broker/service-boundary redesign required by the approved Phase 0A plan | Avoids depending on this local VFS path while preserving the product's fail-closed boundary | Does not make the ordinary suite pass, but is the existing safe product-design path for an `Inconclusive` checkpoint |

A self-signed certificate is not treated as sufficient evidence. Microsoft's Smart
App Control documentation says trusted execution requires cloud reputation or an
RSA code-signing certificate from a provider in the Microsoft Trusted Root Program.
Artifact Signing (formerly Trusted Signing) Public Trust or a qualifying commercial
code-signing CA are examples that require separate account, eligibility, cost, key
custody, and supply-chain review.

### Excluded shortcuts

The following are not accepted as fixes for this security gate:

- switch Smart App Control to Off or Evaluation;
- force the registry state or delete/replace active `.cip` files;
- disable Secure Boot, enable `TESTSIGNING`, or add a Defender exclusion;
- install a self-signed root merely to trust locally generated test binaries;
- move/rename the file, run Cargo as administrator, or rely on a path exception;
- infer success from no new `3077` event, build-only success, Clippy, another host,
  or the earlier primitive observation.

Microsoft documents no per-app bypass switch for consumer Smart App Control.

### Optional hosted-CI evidence, not an authoritative gate

A future user-approved `windows-latest` job could run the ordinary suite without
weakening this physical host. The minimal test payload would be:

```powershell
rustc --version --verbose
cargo --version
git rev-parse HEAD
cargo test --locked -p vault-local-sqlite-vfs-windows `
    --features feasibility-probe -- --test-threads=1
```

Such a job must use read-only repository permissions, a bounded timeout, pinned
third-party action revisions, and must not pass `--ignored`, `--include-ignored`,
or the explicit hard-gate test name. A success would show that the ordinary tests
run in a separate clean Windows environment; it would not satisfy the current
Windows `10.0.26200.0` pinned-host contract or change the `Inconclusive` verdict.
No workflow is added or activated by this record.

## Decision for this work session

1. Do not disable Smart App Control or edit its registry/policy files.
2. Keep the authoritative Phase 0A checkpoint `Inconclusive`.
3. Do not rerun the one-time explicit hard gate.
4. Do not connect `vault-local-sqlite-vfs-windows` to the SQLite store.
5. Before more implementation, obtain explicit approval for exactly one next plan:
   a trusted-signing test pipeline, a dedicated verification-environment contract,
   or the broker/service-boundary redesign.
6. If an approved environment change is later made, rerun only the mandatory
   ordinary suite first and record its integer exit code.

## Reproducible read-only diagnosis

These commands inspect the retained evidence. They do not change policy or run a
test executable:

```powershell
$log = 'Microsoft-Windows-CodeIntegrity/Operational'
$event = Get-WinEvent -FilterHashtable @{
    LogName  = $log
    Id       = 3077
    StartTime = [datetime]'2026-08-29T17:40:00+09:00'
    EndTime   = [datetime]'2026-08-29T17:50:00+09:00'
} |
    Where-Object Message -Match 'vault_local_sqlite_vfs_windows' |
    Select-Object -First 1

$xml = [xml]$event.ToXml()
$xml.Event.System.Correlation.ActivityID
$xml.Event.EventData.Data | ForEach-Object {
    [pscustomobject]@{
        Name  = [string]$_.Name
        Value = [string]$_.'#text'
    }
}
```

```powershell
$exe = 'target\debug\deps\vault_local_sqlite_vfs_windows-386a00a316a81043.exe'
Get-FileHash -LiteralPath $exe -Algorithm SHA256
Get-AuthenticodeSignature -LiteralPath $exe
```

For policy activation evidence:

```powershell
Get-WinEvent -FilterHashtable @{
    LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
    Id      = 3099
} -MaxEvents 30
```

Do not use these findings as authorization to edit
`HKLM:\SYSTEM\CurrentControlSet\Control\CI`, remove `.cip` files, or disable Smart
App Control.

## Official references

- [Microsoft: App Control debugging and troubleshooting](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/appcontrol-debugging-and-troubleshooting)
- [Microsoft: Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)
- [Microsoft: Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)
- [Microsoft: Sign your app for Smart App Control compliance](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [Microsoft: Inbox App Control policies](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/inbox-appcontrol-policies)
- [Microsoft: App Control state and policy overview](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)
- [Microsoft: CiTool technical reference](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/citool-commands)

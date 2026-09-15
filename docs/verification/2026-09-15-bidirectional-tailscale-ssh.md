# 두 Windows 기기 간 Tailscale OpenSSH 검증

기준일: 2026-09-15.

이 기록은 KeyAtlas 협업을 위한 **명령 실행 통로**의 검증 범위만 설명한다.
화면 공유, 마우스·키보드 공유, CPU/GPU/RAM 결합, 분산 AI 실행 성공을 의미하지 않는다.
공개 저장소 문서에는 Tailscale IP, 사용자 이름, 공개 키 원문과 지문을 적지 않는다.

## 대상과 안전 경계

- 메인 Windows 데스크톱과 사용자가 확인한 추가 Windows 노트북만 대상으로 했다.
- 공유기 포트 포워딩이나 인터넷 직접 노출은 만들지 않았다.
- 양쪽 모두 Tailscale P2P 경로의 OpenSSH를 사용한다.
- 개인 키를 읽거나 복사하거나 채팅·Git에 기록하지 않았다.
- 관리자 SSH 영구 접근의 의미를 설명한 뒤 사용자가 명시적으로 승인했다.
- Windows Home 데스크톱의 Microsoft RDP 호스트 우회는 하지 않았다.

## DESKTOP 수신 경로

- `sshd`와 Tailscale 서비스: `Running / Automatic`.
- TCP 22: IPv4와 IPv6에서 수신 확인.
- OpenSSH 인바운드 규칙: Private profile에서 enabled/allow 확인.
- 관리자 계정용 `administrators_authorized_keys`가 기존에 없음을 확인한 뒤 노트북 공개 키 한 개를 등록했다.
- 등록 키는 해당 노트북의 Tailscale 출발지로 제한했다.
- 등록 작업 내부에서 공개 키 지문과 ACL을 검사했고 exit 0이었다.
- ACL은 상속을 제거하고 `SYSTEM`과 `Administrators`만 허용했다.
- DESKTOP OpenSSH 운영 로그에서 해당 노트북 키 지문의 `Accepted publickey`를 확인했다.

## LAPTOP 수신 경로

- DESKTOP에서 Tailscale 인터페이스를 통해 노트북 TCP 22 도달을 확인했다.
- 네트워크에서 관찰한 노트북 ED25519 host key 지문과 노트북 로컬 지문이 일치한다는 사용자 전달을 받은 뒤에만 host key를 신뢰 등록했다.
- `codex_fleet_ed25519`를 명시한 첫 검사는 exit 255 / public-key 거부였다.
- 기존 `id_ed25519`를 명시하고 password/keyboard-interactive fallback을 끈 검사는 exit 0, 정확한 노트북 hostname 반환이었다.
- 이어서 같은 키로 원격 `whoami`, 관리자 키 파일 지문, ACL, `sshd`/Tailscale 상태를 읽었다.
- 원격 관리자 키 파일에는 실제 성공한 `id_ed25519` 공개 키 지문 한 개만 있었다. ACL은 `SYSTEM`과 `Administrators` Full Control뿐이었다.
- 노트북의 `sshd`와 Tailscale도 `Running / AUTO_START`였다.

따라서 실제 증거상 양방향 OpenSSH는 동작하지만, “codex_fleet 키로 역방향 성공”이라는 중간 보고는 틀렸다.
작동 중인 키 한 개를 유지하고 불필요한 두 번째 관리자 키를 추가하지 않았다.

## 완료와 미완료

검증 완료:

- 노트북 → 데스크톱: 공개 키 인증 수신 로그와 정확한 데스크톱 hostname.
- 데스크톱 → 노트북: password fallback을 차단한 공개 키 인증 exit 0, 정확한 노트북 hostname과 계정.
- 양쪽 `sshd` 및 Tailscale 자동 시작 설정.

별도 미완료:

- 재부팅 직후 실제 재접속 시험.
- 절전 해제/Wake-on-LAN.
- PowerToys Mouse Without Borders 페어링.
- AnyDesk 설치·양방향 화면 제어·무인 접속.
- SSH를 사용한 KeyAtlas 동일 SHA 재현 테스트 또는 분산 작업 큐.
- CPU/GPU 모델 분산 실행과 작업 결과 취합.

`sshd`와 Tailscale의 자동 시작은 전원·Windows·네트워크가 켜진 뒤 로그인 전 접속 가능성을 제공한다.
전원이 꺼졌거나 절전 중이거나 네트워크/Tailscale 연결이 끝나지 않은 동안의 접속을 보장하지 않는다.

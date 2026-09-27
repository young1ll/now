# 인프라 (IaC · OpenTofu)

Now 의 실행 환경은 코드로만 바꾼다. 현재 대상은 **로컬 Docker** (클라우드는 미정 — 로드맵).

| 리소스 | |
|---|---|
| `docker_network.app` | `now-net` |
| `docker_volume.data` | `now-data` — SQLite 데이터. `prevent_destroy` |
| `docker_container.app` | `now` — 127.0.0.1:3000, 헬스체크 `/api/health`, 메모리 512MB, `unless-stopped` |
| `data.docker_image.app` | `now:local` 이미지 digest 고정 → 재빌드 시 plan 에 교체가 보인다 |

## 배포

```bash
npm run iac:build                 # docker build -t now:local .
cd infra
cp terraform.tfvars.example terraform.tfvars   # (선택) 포트·운영자 이름
tofu init        # 처음 한 번 — 생성되는 .terraform.lock.hcl 은 커밋한다 (프로바이더 버전·해시 고정)
tofu plan
tofu apply
```

## 현행 감사 · 모니터링

```bash
# 로컬 DB 에 기록 (개발 모드)
npm run iac:audit

# 배포된 앱에 기록 (컨테이너 볼륨의 DB) — 에이전트 토큰 필요
NOW_URL=http://127.0.0.1:3000 NOW_AGENT_TOKEN=now_… npm run iac:audit
```

- `tofu show -json` 으로 **현재 관리 리소스**, `tofu plan -detailed-exitcode` 로 **코드와의 차이(드리프트)** 를 수집한다.
- 결과는 콘솔 `/system` 과 오퍼레이션 상태 스트립·신호에 표시된다 (드리프트 = 심각 신호).
- 종료 코드 `0` 일치 · `2` 드리프트 · `1` 오류 → cron/CI 알림에 그대로 사용.
- 비밀값은 기록하지 않는다: 컨테이너 env 는 **키 이름만**, 비밀로 보이는 속성은 제외.

cron 예시 (매시간):
```cron
7 * * * * cd /path/to/now && NOW_URL=http://127.0.0.1:3000 NOW_AGENT_TOKEN=now_… npm run -s iac:audit >> data/iac-audit.log 2>&1
```

## 규칙

- 콘솔에 로그인이 없으므로 `bind_ip` 는 127.0.0.1 유지. 외부 공개는 인증 추가 후.
- 수동 `docker update/run` 으로 바꾸지 않는다 — 감사에서 드리프트로 잡힌다. 코드로 고치고 `tofu apply`.
- state(`terraform.tfstate`)는 커밋하지 않는다. 클라우드로 옮길 때 원격 백엔드 + 잠금으로 교체.

## 검증 기록

로컬 Docker 에서 다음을 실제로 확인했다: `apply` → 컨테이너 healthy → 감사 `in_sync(0)` →
`docker update --restart=no` 수동 변경 → 감사 `drift(2)` · `update docker_container.app` → `apply` 복구 → `in_sync`.
이미지 재빌드 → 감사 `drift` · `delete/create` (교체 필요) 로 표시.

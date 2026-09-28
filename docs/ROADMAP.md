# 로드맵

## v0.2 (현재) — AI 운영 계층
- [x] 온톨로지 · 액션 · 정책 · 감사 (단일 관문)
- [x] MCP(HTTP/stdio) · REST · 에이전트 토큰 관리
- [x] 승인함 · 활동 로그 · 신호 큐 · AI 운영 모드 4단계
- [x] Blueprint 계열 콘솔 디자인 시스템
- [x] OpenTofu 로컬 Docker 배포 + 현행 감사/드리프트
- [x] 온라인 백업 액션 (VACUUM INTO)

## v0.3 — 이벤트 · 그래프 · AI 다각화
- [x] 이벤트 버스(outbox) · 워커 · 신호 변화 감지 · cron 스케줄
- [x] 트리거 → AI 세션 / 웹훅(서명·재시도), 루프 방지·쿨다운·한도
- [x] AI 런타임: Claude(공식 SDK) · OpenAI · Gemini · OpenRouter · Ollama/LM Studio · 로컬 CLI 에이전트
- [x] now CLI · OpenAPI · SSE · MCP 도구 13종 (traverse · find_path · list_events)
- [x] 온톨로지: 스키마 데이터화, 1급 링크, 링크 유형 정의, 그래프 탐색 UI, Neo4j 동기화
- [x] 열 기반 UI (목록 │ 선택 │ 연결, 너비 조정·기억)

## 다음 (v0.4) — 기억 · 지식 · 검색 ([설계](MEMORY.md))
- [x] M1 검색 기반: 청크·객체 카드, 하이브리드 `recall` (FTS + 그래프), 골든셋 `eval:recall`, `/search` · MCP `recall` · `now recall`
- [x] M2 벡터: sqlite-vec (bit→float 재정렬), 로컬 우선 임베딩(Ollama · OpenAI · Gemini · Voyage · OpenAI 호환), 임베딩 공간 교체, 색인 비밀값 가림, `eval:recall --embed-url · --vec-bench`
- [x] M3 기억: `memory` 객체 · 상태 기계 · 액션 10종 · 어휘 중복/숫자 충돌 · 오염 상속 · 컨텍스트 팩(세션 해시·인용 추적) · `/memory` · "AI 가 아는 것" · MCP `get_context`·`remember`·`cite`·`list_memories` · `now context`·`remember`·`memories`
- [x] M4 큐레이터: 문서 종류·버전(`notes.kind` · `note_versions`) · 외부 자료 가져오기 · 에피소드(결정적 세션 요약, 워커) · 플레이북(`[[action:…]]`, 팩 우선) · 결정적 큐레이터(미사용·유효기간 만료 · 의미 중복 합치기 · 승격 후보 신호 · `curator.ran`) · LLM 큐레이터(야간 트리거 + `list_episodes`) · 사용 기록 정밀도
- [x] M5 신뢰 사다리: 에이전트 역할 · 허용 액션(glob) · 사업 범위(쓰기 거부 + 읽기 도구 필터) · 자율 권한(액션 하나 · 만료 · 승인 시점 재검사) · 문제 표시 · 신뢰 지표(`action_runs` 에서 — 승인률 · 기억 정밀도) · 넓힐 후보 신호 · 자동 회수·강등(워커, SYSTEM) · 기억 활성 착지 · `whoami` · 신뢰 카드 · 자율도

**v0.4 요약** — 에이전트가 기억하고(기억 객체 · 컨텍스트 팩 · 인용), 찾고(하이브리드 회상 · 벡터), 정리하고(에피소드 · 플레이북 · 큐레이터), 사람의 판단 기록으로 권한이 넓어지고 좁아진다(신뢰 사다리). 모든 변화는 여전히 하나의 액션 관문과 감사 로그를 지난다.

## 그 다음
- [ ] 사용자 정의 객체 유형 · 속성 (스키마 편집기)
- [ ] 파생 속성 함수 (고객 LTV · 미수 잔액 · 업무 리드타임)
- [ ] 반복 청구서 · 세금 캘린더 프리셋
- [ ] 메일·캘린더 연동 액션 (외부 발송은 항상 high)
- [ ] 되돌리기 (역-액션)
- [ ] 콘솔 인증 (패스키) → 원격 접속
- [ ] 명령 팔레트 (Ctrl+K)

## 이후
- [ ] 클라우드 모듈 (대상 확정 후) + 원격 state
- [ ] 발생주의 손익, 다중 통화 환산
- [ ] 문서 첨부 파일

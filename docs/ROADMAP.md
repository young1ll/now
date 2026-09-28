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
- [ ] M2 벡터: sqlite-vec (bit→float 재정렬), 로컬 우선 임베딩(Ollama), 임베딩 공간 교체
- [ ] M3 기억: `memory` 객체 · 상태 기계 · 액션 8종 · 충돌/오염 방지 · `/memory` · MCP `remember`·`get_context`
- [ ] M4 큐레이터: 에피소드 요약 · 기억 추출/병합/만료 · 승격 제안 · 플레이북
- [ ] M5 신뢰: 에이전트 역할·범위, 기억 신뢰도, 자동 착지

## 그 다음
- [ ] 사용자 정의 객체 유형 · 속성 (스키마 편집기)
- [ ] 파생 속성 함수 (고객 LTV · 미수 잔액 · 업무 리드타임)
- [ ] 반복 청구서 · 세금 캘린더 프리셋
- [ ] 메일·캘린더 연동 액션 (외부 발송은 항상 high)
- [ ] 되돌리기 (역-액션)
- [ ] 에이전트별 권한 범위 (허용 액션·사업 스코프)
- [ ] 콘솔 인증 (패스키) → 원격 접속
- [ ] 명령 팔레트 (Ctrl+K)

## 이후
- [ ] 클라우드 모듈 (대상 확정 후) + 원격 state
- [ ] 발생주의 손익, 다중 통화 환산
- [ ] 문서 첨부 파일

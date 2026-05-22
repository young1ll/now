# TaxBrief

> 1인 세무사를 위한 상담 보조 데스크톱(로컬 웹) 도구.
> 질문 한 줄을 입력하면 **국가법령정보센터 OPEN API**로 관련 법령을 찾아내고,
> Claude가 **근거 인용 답변**을 작성하여 화면에 표시합니다.
> 브라우저 인쇄(Ctrl/Cmd+P → PDF로 저장)로 고객용 PDF 보고서를 만듭니다.

기획 상세: [docs/기획서.md](docs/기획서.md)

---

## 빠른 시작 (오늘 사용)

### 1. 사전 준비

- **Node.js 20+** (권장 22+)
- **국가법령정보센터 OC 인증키** — https://open.law.go.kr 가입 후 발급
- **Claude API 키** — https://console.anthropic.com 발급

### 2. 환경변수

```bash
cp .env.local.example .env.local
```

`.env.local`을 열어 두 값을 입력:

```
LAW_OC=<발급받은 OC>
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6
```

> ⚠️ `.env.local`은 `.gitignore`에 포함되어 절대 커밋되지 않습니다.
> 키가 채팅 등 외부에 노출된 적이 있다면 발급처에서 재발급 후 새 값으로 갱신하세요.

### 3. 의존성 설치

```bash
npm install
```

### 4. (선택) 사전 검증

```bash
# 모킹된 통합 테스트 (네트워크 불필요, 즉시 실행)
npm test

# 보고서 레이아웃 미리보기 (외부 API 호출 없음)
npm run demo:render
# → ./sample-report.html 생성. 브라우저로 열어 Ctrl/Cmd+P 미리보기

# 실제 외부 API 단독 검증 (네트워크 + 키 필요)
npm run smoke:law
npm run smoke:law "상속세 및 증여세법"
npm run smoke:claude
npm run smoke:claude "양도소득세 장기보유특별공제"
```

`npm test`는 외부 호출을 모킹하므로 API 키 없이도 파이프라인을 검증합니다.
`npm run smoke:*`는 실제 키와 네트워크를 사용해 응답 형식 차이를 미리 잡아냅니다.

### 5. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 http://localhost:3000 접속.

### 6. 사용 흐름

1. 입력창에 질문 입력 (예: `1세대 1주택 비과세 거주요건`)
2. **Ctrl/Cmd + Enter** 또는 [상담 보고서 생성] 클릭
3. 10~25초 후 결과(요약·상세·인용·면책) 표시
4. **Ctrl/Cmd + P** → 대상을 "PDF로 저장" 선택 → 끝
   - 인쇄 미리보기에서 입력창·버튼은 자동으로 숨겨집니다.

---

## 구조

```
now/
├─ app/
│  ├─ page.tsx              # 단일 페이지 (입력 + 결과)
│  ├─ layout.tsx
│  ├─ globals.css           # 화면 + @media print 인쇄용 스타일
│  └─ api/ask/route.ts      # POST /api/ask 오케스트레이션
├─ lib/
│  ├─ law.ts                # 국가법령정보센터 클라이언트
│  ├─ claude.ts             # Claude (키워드 추출 + 답변 합성)
│  └─ types.ts
├─ scripts/
│  ├─ smoke-law.ts          # 법령 API 단독 검증 (실 호출)
│  ├─ smoke-claude.ts       # Claude API 단독 검증 (실 호출)
│  └─ render-sample.ts      # 샘플 보고서 HTML 생성 (인쇄 레이아웃 미리보기)
├─ tests/
│  ├─ integration.test.ts   # 외부 API 모킹 통합 테스트 (npm test)
│  └─ fixtures/
└─ docs/기획서.md
```

---

## 처리 흐름

```
POST /api/ask  { question }
  │
  ├─ Claude: extractKeywords()    → ["소득세법", "1세대 1주택"]
  ├─ 국가법령정보센터: searchLaws() → 상위 3건 MST
  ├─ 국가법령정보센터: getLawBody() (병렬)
  └─ Claude: synthesizeAnswer()
        ↓
  { question, summary, detail, citations[], disclaimer, generatedAt, model }
```

---

## 오늘 MVP에 의도적으로 **없는** 것

- 이력 저장 (DB) · 세션 관리 · 고객 정보
- 답변 편집 UI
- 설정 화면 (모든 키는 `.env.local`)
- 회사 로고·보고서 템플릿 커스터마이즈
- 판례·해석례 조회 (법령만)
- 캐싱·로그 인프라
- 이메일 발송, Electron 패키징

전체 보류 목록은 [docs/기획서.md §12](docs/기획서.md)에 있습니다.

---

## 트러블슈팅

| 증상 | 원인·해결 |
|---|---|
| `LAW_OC 환경변수가 설정되지 않았습니다` | `.env.local` 없음 또는 키 비어있음. 입력 후 dev 서버 재시작 |
| `법령 검색 실패 (403)` | OC 키 활성화 전(발급 후 활성까지 시간 걸릴 수 있음) 또는 잘못된 키 |
| `법령 검색 응답을 JSON으로 파싱 실패` | OC 키가 유효하지 않거나, target/type 파라미터 변경 필요. 응답 앞부분 로그 확인 |
| `ANTHROPIC_API_KEY 환경변수…` | `.env.local`에 키 추가 후 dev 서버 재시작 |
| PDF 인쇄 시 한글 깨짐 | OS 기본 한글 폰트 미설치. macOS/Windows 최신 버전이면 보통 OK |
| 응답이 30초 이상 걸림 | 정상 범위 상한. 더 길면 키워드를 더 구체적으로 |

---

## 라이선스 / 출처

- 법령 데이터: **국가법령정보센터** (공공누리)
- 본 도구는 일반 안내용이며 법적 자문이 아닙니다.

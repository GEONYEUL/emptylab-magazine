# Empty Lab Magazine

커피 산업 뉴스를 수집하고, Gemini 전처리와 Claude 글쓰기를 거쳐 Notion과 Slack으로 발행하는 Next.js App Router 프로젝트입니다.

## 구조

```txt
app/
  page.js                 # 파이프라인 실행 UI
  components/             # 입력, 진행 상태, 결과, 오류 표시 컴포넌트
  api/
    collect/route.js      # 뉴스 수집
    preprocess/route.js   # Gemini 전처리
    write/route.js        # Claude 글쓰기
    save/route.js         # Notion 저장 + Slack 알림
    cron/route.js         # Vercel Cron 전체 실행

lib/
  scraper.js              # RSS/HTML 뉴스 수집
  pipeline.js             # AI 처리와 저장 파이프라인
  prompt.js               # Gemini/Claude 프롬프트
  notion.js               # Notion 저장
  slack.js                # Slack 알림
  api.js                  # API 요청 검증 유틸
  env.js                  # 환경변수 검증 유틸
```

## 실행

```bash
npm install
npm run dev
```

프로덕션 빌드 확인:

```bash
npm run build
```

Windows PowerShell 실행 정책 때문에 `npm`이 막히면 아래처럼 실행합니다.

```bash
npm.cmd run build
```

## 환경변수

필수:

```txt
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
NOTION_API_KEY=
NOTION_DATABASE_ID=
```

선택:

```txt
SLACK_WEBHOOK_URL=
CRON_SECRET=
```

`CRON_SECRET`이 설정되어 있으면 `/api/cron` 요청에는 `Authorization: Bearer <CRON_SECRET>` 헤더가 필요합니다.

## API 흐름

1. `/api/collect`: 최근 7일 이내 커피/F&B 관련 기사 수집
2. `/api/preprocess`: Gemini가 기사 묶음을 정제 JSON으로 전처리
3. `/api/write`: Claude가 매거진 아티클 JSON 생성
4. `/api/save`: Notion 저장 후 Slack 알림
5. `/api/cron`: 위 흐름을 서버에서 한 번에 실행

## 배포

[vercel.json](./vercel.json)은 매일 `0 0 * * *` UTC 기준으로 `/api/cron`을 호출합니다. 한국 시간으로는 오전 9시입니다.

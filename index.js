require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk').default;

// 내부 모듈
const { GEMINI_PREPROCESS_PROMPT, CLAUDE_SYSTEM_PROMPT, CLAUDE_USER_PROMPT_TEMPLATE } = require('./prompt');
const { scrapeSources } = require('./scraper');
const { saveToNotion } = require('./notion');
const { sendSlackNotification } = require('./slack');

// AI 클라이언트 초기화
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 로그 백업 디렉토리 (에러 시 JSON 파일로 저장)
const LOGS_DIR = path.join(__dirname, 'logs');

// ──────────────────────────────────────────────────
// 유틸리티: 로컬 백업 저장
// ──────────────────────────────────────────────────
async function saveLocalBackup(data, prefix = 'backup') {
    try {
        await fs.mkdir(LOGS_DIR, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(LOGS_DIR, `${prefix}_${timestamp}.json`);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[DEBUG] 💾 로컬 백업 저장 완료: ${filePath}`);
    } catch (err) {
        console.error('[ERROR] 로컬 백업 저장 실패:', err.message);
    }
}

// ──────────────────────────────────────────────────
// STEP 0: 뉴스 수집
// ──────────────────────────────────────────────────
async function fetchNews() {
    try {
        const articles = await scrapeSources();
        return articles;
    } catch (error) {
        console.error('[ERROR] ❌ 뉴스 수집 중 오류 발생:', error.message);
        throw error;
    }
}

// ──────────────────────────────────────────────────
// STEP 1: 데이터 전처리 (Gemini 담당)
// - 광고 제거, 팩트 추출, 테마 선정, 키워드 추출
// - temperature 0.3으로 일관된 분류 결과 확보
// ──────────────────────────────────────────────────
async function preprocessWithGemini(newsData) {
    console.log('[STEP 1] 🤖 Gemini 데이터 전처리를 시작합니다...');

    // 유효 기사 3개 미만이면 API 호출 자체를 생략 (비용 절감)
    if (!newsData || newsData.length < 3) {
        console.log('[STEP 1] ⚠️ 유효한 수집 기사가 3개 미만입니다.');
        return {
            error: "INSUFFICIENT_DATA",
            message: "유효한 기사가 3개 미만입니다. 수동 확인이 필요합니다.",
            count: newsData ? newsData.length : 0,
        };
    }

    try {
        // 토큰 절약을 위해 최대 30개 기사만 전달
        const trimmedData = newsData.slice(0, 30);
        const promptWithData = GEMINI_PREPROCESS_PROMPT.replace(
            '{{ARTICLES_JSON}}',
            JSON.stringify(trimmedData, null, 2)
        );

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
                responseMimeType: "application/json", // JSON 강제 출력
                temperature: 0.3, // 일관된 분류를 위해 낮은 온도
            },
        });

        console.log(`[STEP 1] 🧠 Gemini에게 ${trimmedData.length}개 기사 전처리를 요청합니다...`);
        const result = await model.generateContent(promptWithData);
        const geminiOutput = JSON.parse(result.response.text());

        // Gemini가 에러 JSON을 반환했을 경우
        if (geminiOutput.error) {
            console.log(`[STEP 1] ⚠️ Gemini 에러 반환: ${geminiOutput.message}`);
            return geminiOutput;
        }

        console.log(`[STEP 1] ✔ 완료: 테마 선정 → ${geminiOutput.theme_label}`);
        return geminiOutput;
    } catch (error) {
        console.error('[STEP 1] ❌ Gemini 전처리 중 오류:', error.message);
        throw error;
    }
}

// ──────────────────────────────────────────────────
// STEP 2: 수석 에디터 글쓰기 (Claude 담당)
// - system prompt: 마스터 프롬프트 v2.1 고정
// - user prompt: Gemini 전처리 결과를 동적 주입
// - temperature 0.7로 창의적 글쓰기
// ──────────────────────────────────────────────────
async function writeWithClaude(geminiOutput) {
    console.log('[STEP 2] ✍️ Claude 수석 에디터 글쓰기를 시작합니다...');

    try {
        // 유저 프롬프트에 Gemini 결과 주입
        const userPrompt = CLAUDE_USER_PROMPT_TEMPLATE.replace(
            '{{GEMINI_OUTPUT_JSON}}',
            JSON.stringify(geminiOutput, null, 2)
        );

        const message = await anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 4096,
            temperature: 0.7,
            system: CLAUDE_SYSTEM_PROMPT,
            messages: [
                { role: "user", content: userPrompt },
            ],
        });

        // Claude 응답에서 텍스트 추출
        const responseText = message.content[0].text;

        // JSON 파싱 (Claude가 코드블록으로 감쌀 수 있으므로 정리)
        const cleanedText = responseText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const parsedData = JSON.parse(cleanedText);

        // Gemini에서 가져온 meta 정보를 보강
        if (!parsedData.meta) parsedData.meta = {};
        parsedData.meta.sources_used = parsedData.meta.sources_used || geminiOutput.sources_used || [];
        parsedData.meta.source_count = parsedData.meta.source_count || geminiOutput.source_count || 0;
        parsedData.meta.theme_category = parsedData.meta.theme_category || geminiOutput.theme_category;
        parsedData.meta.theme_label = parsedData.meta.theme_label || geminiOutput.theme_label;

        console.log(`[STEP 2] ✔ 완료: 칼럼 생성 → "${parsedData.article?.title}"`);
        return parsedData;
    } catch (error) {
        console.error('[STEP 2] ❌ Claude 글쓰기 중 오류:', error.message);
        throw error;
    }
}

// ──────────────────────────────────────────────────
// 메인 파이프라인 실행
// ──────────────────────────────────────────────────
async function runPipeline() {
    const startTime = Date.now();
    console.log('=============================================');
    console.log('🚀 [START] 자동화 뉴스룸 파이프라인 실행');
    console.log(`📅 실행 시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    console.log('📐 아키텍처: Gemini(전처리) → Claude(글쓰기) 체이닝');
    console.log('=============================================');

    try {
        // ── STEP 0: 뉴스 수집 ──
        const newsData = await fetchNews();

        // ── STEP 1: Gemini 전처리 ──
        const geminiOutput = await preprocessWithGemini(newsData);

        // Gemini가 INSUFFICIENT_DATA 에러 반환 시 → Claude 호출 없이 중단
        if (geminiOutput.error) {
            console.log('[PIPELINE] ⚠️ 데이터 부족으로 파이프라인을 중단합니다.');
            await sendSlackNotification(geminiOutput, null); // 에러 알림 발송
            return;
        }

        // ── STEP 2: Claude 글쓰기 ──
        let finalData;
        try {
            finalData = await writeWithClaude(geminiOutput);
        } catch (claudeError) {
            // Claude 파싱 실패 시 → fallback으로 Gemini 원본을 Notion에 저장
            console.error('[PIPELINE] ⚠️ Claude 파싱 실패. Gemini 원본을 fallback으로 저장합니다.');
            await saveLocalBackup(geminiOutput, 'claude_fallback');

            // Slack 에러 알림 발송
            await sendSlackNotification({
                error: "CLAUDE_PARSE_ERROR",
                message: `Claude 글쓰기 실패: ${claudeError.message}. Gemini 원본이 logs/ 폴더에 백업되었습니다.`,
            }, null);
            return;
        }

        // ── STEP 3: Notion 저장 + Slack 알림 ──
        let notionUrl = null;
        try {
            notionUrl = await saveToNotion(finalData);
        } catch (notionError) {
            // Notion 저장 실패 시 → 로컬 백업 + Slack 에러 알림
            console.error('[PIPELINE] ⚠️ Notion 저장 실패. 로컬에 백업합니다.');
            await saveLocalBackup(finalData, 'notion_fallback');
        }

        try {
            await sendSlackNotification(finalData, notionUrl);
        } catch (slackError) {
            // Slack 전송 실패 시 → 로컬 백업
            console.error('[PIPELINE] ⚠️ Slack 전송 실패. 로컬에 백업합니다.');
            await saveLocalBackup(finalData, 'slack_fallback');
        }

        console.log(`[STEP 3] ✔ 완료: Notion 저장 + Slack 발송`);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n🎉 [SUCCESS] 모든 파이프라인 작업이 완료되었습니다. (소요 시간: ${elapsed}초)\n`);
    } catch (error) {
        console.error('💥 [CRITICAL ERROR] 파이프라인 실행 중 치명적 오류 발생:', error.message);
        await saveLocalBackup({ error: error.message, stack: error.stack }, 'critical_error');
    }
}

// ──────────────────────────────────────────────────
// 스케줄러 (매일 오전 9시 KST)
// ──────────────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
    console.log('[SCHEDULER] 예약된 시간에 파이프라인을 실행합니다.');
    runPipeline();
}, {
    timezone: "Asia/Seoul",
});

console.log('✅ 자동화 뉴스룸 파이프라인 스케줄러 시작 (매일 오전 9시 KST)');
console.log('📐 아키텍처: Gemini(전처리) → Claude(글쓰기) 체이닝');

// 즉시 실행 모드: node index.js --run-now
if (process.argv.includes('--run-now')) {
    runPipeline();
}

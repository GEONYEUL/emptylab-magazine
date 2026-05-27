// lib/pipeline.js
// 공통 파이프라인 로직 — API 라우트에서 공유
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { scrapeSources } from './scraper.js';
import { GEMINI_PREPROCESS_PROMPT, CLAUDE_SYSTEM_PROMPT, CLAUDE_USER_PROMPT_TEMPLATE, GEMINI_EXTRACT_ISSUES_PROMPT, GEMINI_REVIEW_PROMPT } from './prompt.js';
import { saveToNotion } from './notion.js';
import { sendSlackNotification } from './slack.js';
import { requireEnv } from './env.js';

// ── 지수 백오프 재시도 유틸 ──
// 왜 필요한가: Claude API가 과부하(529) 또는 Rate Limit(429)일 때
// 즉시 실패하지 않고, 대기 후 재시도하여 성공률을 높이기 위함
const RETRY_CONFIG = {
    maxRetries: 3,         // 최대 재시도 횟수
    baseDelayMs: 5000,     // 기본 대기 시간 (5초)
    maxDelayMs: 30000,     // 최대 대기 시간 (30초)
    retryableStatuses: [429, 500, 502, 503, 504, 529],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 지수 백오프로 대기 시간 계산 (jitter 추가로 동시 재시도 충돌 방지)
function getRetryDelay(attempt) {
    const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // 0~1초 랜덤 지연
    return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

// API 호출을 재시도 가능하게 감싸는 래퍼 함수
async function withRetry(label, apiCallFn) {
    let lastError;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            lastError = error;

            // Anthropic SDK는 에러 객체에 status 속성을 포함함
            const status = error?.status || error?.statusCode;
            const isRetryable = RETRY_CONFIG.retryableStatuses.includes(status);

            // 재시도 불가능한 에러이거나, 마지막 시도였으면 즉시 throw
            if (!isRetryable || attempt >= RETRY_CONFIG.maxRetries) {
                throw error;
            }

            const delay = getRetryDelay(attempt);
            console.warn(
                `[${label}] ⚠️ ${status} 에러 발생 (시도 ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}), ` +
                `${Math.round(delay / 1000)}초 후 재시도...`
            );
            await sleep(delay);
        }
    }

    throw lastError;
}

function cleanJsonText(text) {
    let cleaned = String(text || '')
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
        
    // 후행 쉼표(trailing comma) 제거: 객체나 배열의 마지막 요소 뒤에 있는 쉼표 제거
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    
    return cleaned;
}

// 왜 별도 함수로 분리했는가: Claude가 JSON 문자열 내부에 이스케이프되지 않은
// 따옴표, 개행, 제어문자를 넣는 경우가 빈번하여 1차 파싱이 자주 실패함.
// 여러 단계의 복구 전략을 순서대로 시도하여 최대한 파싱 성공률을 높임.
function repairJson(text) {
    let repaired = text;

    // 1단계: JSON 문자열 값 내부의 실제 개행문자를 \\n으로 이스케이프
    // "key": "값 중간에
    // 줄바꿈이 있으면" → "key": "값 중간에\\n줄바꿈이 있으면"
    repaired = repaired.replace(/"([^"]*)\n([^"]*?)"/g, (match) => {
        return match.replace(/\n/g, '\\n');
    });
    // 여러 줄에 걸친 경우 반복 적용 (최대 10회)
    for (let i = 0; i < 10; i++) {
        const before = repaired;
        repaired = repaired.replace(/"([^"]*)\n([^"]*?)"/g, (match) => {
            return match.replace(/\n/g, '\\n');
        });
        if (before === repaired) break;
    }

    // 2단계: JSON 문자열 값 내부의 이스케이프되지 않은 탭 제거
    repaired = repaired.replace(/"([^"]*)\t([^"]*?)"/g, (match) => {
        return match.replace(/\t/g, '\\t');
    });

    // 3단계: 제어문자 제거 (0x00~0x1F 중 \n, \r, \t 제외)
    repaired = repaired.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    // 4단계: 후행 쉼표 재처리
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    return repaired;
}

function parseJsonText(text, label) {
    // 방어 처리: 이미 파싱된 객체/배열이면 그대로 반환
    // (새 SDK에서 responseMimeType:"application/json" 사용 시 이미 파싱된 값이 올 수 있음)
    if (text !== null && typeof text === 'object') {
        console.log(`[${label}] ✅ 응답이 이미 파싱된 객체 (타입: ${Array.isArray(text) ? 'array' : 'object'})`);
        return text;
    }

    const cleanedText = cleanJsonText(text);
    if (!cleanedText) throw new Error(`${label} returned an empty response`);

    let parsedResult;

    // 1차 시도: 원본 그대로 파싱
    try {
        parsedResult = JSON.parse(cleanedText);
    } catch (firstError) {
        console.warn(`[${label}] 1차 JSON 파싱 실패, 복구 시도 중...`);

        // 2차 시도: repairJson으로 복구 후 파싱
        try {
            const repaired = repairJson(cleanedText);
            parsedResult = JSON.parse(repaired);
            console.log(`[${label}] ✅ JSON 복구 성공!`);
        } catch (secondError) {
            // 3차 시도: JSON 블록만 추출 (앞뒤 설명 텍스트가 섞인 경우)
            try {
                const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const extracted = repairJson(jsonMatch[0]);
                    parsedResult = JSON.parse(extracted);
                    console.log(`[${label}] ✅ JSON 블록 추출 후 파싱 성공!`);
                } else {
                    throw new Error('No JSON block found');
                }
            } catch (thirdError) {
                // 에러 위치 파악을 위한 디버그 로그
                const match = firstError.message.match(/position (\d+)/);
                if (match) {
                    const pos = parseInt(match[1], 10);
                    const start = Math.max(0, pos - 80);
                    const end = Math.min(cleanedText.length, pos + 80);
                    console.error(`[${label}] JSON 파싱 실패 위치(pos ${pos}) 주변 텍스트:\n...${cleanedText.substring(start, end)}...`);
                } else {
                    console.error(`[${label}] JSON 파싱 실패. 원본 응답 앞부분:`, cleanedText.substring(0, 500));
                }
                throw new Error(`${label} JSON 파싱 실패: ${firstError.message}`);
            }
        }
    }
    
    // 최종 검증: 파싱된 결과가 객체나 배열이 아닌 경우(문자열, 숫자 등) 에러 처리
    if (parsedResult !== null && typeof parsedResult !== 'object') {
        throw new Error(`${label} 반환값이 JSON 객체가 아닙니다 (타입: ${typeof parsedResult}). 원문: ${cleanedText.substring(0, 100)}...`);
    }

    return parsedResult;
}

function getFirstTextBlock(content) {
    if (!Array.isArray(content)) return '';
    const textBlock = content.find(block => block?.type === 'text' && typeof block.text === 'string');
    return textBlock?.text || '';
}

// ── STEP 0.5: Gemini 이슈 추출 ──
export async function step_extract_issues(articles, keyword = null) {
    if (!articles || articles.length < 2) {
        return {
            error: "INSUFFICIENT_DATA",
            message: "유효한 기사가 2개 미만입니다.",
            count: articles ? articles.length : 0,
        };
    }

    // 새 SDK: @google/genai — 중앙 집중형 클라이언트 패턴
    const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

    let promptWithData = GEMINI_EXTRACT_ISSUES_PROMPT.replace(
        '{{ARTICLES_JSON}}',
        JSON.stringify(articles, null, 2)
    );
    
    promptWithData = promptWithData.replace(
        '{{USER_KEYWORD}}',
        keyword ? `"${keyword}"` : "지정된 키워드 없음"
    );

    promptWithData = promptWithData.replace(
        '{{TODAY_DATE}}',
        new Date().toISOString().substring(0, 10)
    );

    // withRetry: Gemini 서버 과부하(429, 503 등) 시 자동 재시도
    const result = await withRetry('Gemini 이슈 추출', () =>
        ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: promptWithData,
            config: {
                responseMimeType: "application/json",
                temperature: 0.2,
            },
        })
    );
    const responseText = result.text;
    console.log(`[Gemini 이슈 추출] 응답 타입: ${typeof responseText}, 길이: ${typeof responseText === 'string' ? responseText.length : 'N/A'}`);
    let issuesOutput = parseJsonText(responseText, 'Gemini 이슈 추출');
    
    // 배열로 반환된 경우 처리 방어 로직
    if (Array.isArray(issuesOutput)) {
        console.log('[Gemini 이슈 추출] 배열이 반환됨. 객체로 변환합니다.');
        issuesOutput = { issues: issuesOutput };
    }

    return issuesOutput;
}

// ── STEP 1: Gemini 전처리 ──
export async function step1_preprocess(articles, keyword = null) {
    if (!articles || articles.length < 2) {
        return {
            error: "INSUFFICIENT_DATA",
            message: "유효한 기사가 2개 미만입니다.",
            count: articles ? articles.length : 0,
        };
    }

    const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

    let promptWithData = GEMINI_PREPROCESS_PROMPT.replace(
        '{{ARTICLES_JSON}}',
        JSON.stringify(articles, null, 2)
    );
    
    promptWithData = promptWithData.replace(
        '{{SELECTED_ISSUE}}',
        keyword ? `선택된 이슈/키워드: "${keyword}"` : "지정된 이슈 없음 (오늘의 전체 트렌드 분석)"
    );

    // 오늘 날짜를 프롬프트에 주입 (Gemini가 날짜 기반으로 기사를 검증하기 위함)
    promptWithData = promptWithData.replace(
        '{{TODAY_DATE}}',
        new Date().toISOString().substring(0, 10)
    );

    // gemini-3.1-pro: 2.5 대비 속도·정확도 모두 향상된 최신 Pro 모델
    const result = await withRetry('Gemini 전처리', () =>
        ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: promptWithData,
            config: {
                responseMimeType: "application/json",
                temperature: 0.3,
            },
        })
    );
    const responseText = result.text;
    console.log(`[Gemini 전처리] 응답 타입: ${typeof responseText}, 길이: ${typeof responseText === 'string' ? responseText.length : 'N/A'}`);
    let geminiOutput = parseJsonText(responseText, 'Gemini 전처리');

    // 방어 로직: 모델이 객체 대신 배열을 반환하는 경우 첫 번째 요소를 사용
    if (Array.isArray(geminiOutput)) {
        console.log('[Gemini 전처리] 배열이 반환됨. 첫 번째 요소를 사용합니다.');
        geminiOutput = geminiOutput[0] || { error: "EMPTY_ARRAY", message: "빈 배열이 반환되었습니다." };
    }

    if (geminiOutput.error) return geminiOutput;
    return geminiOutput;
}

// ── STEP 2: Claude 글쓰기 ──
export async function step2_write(geminiOutput) {
    const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

    const userPrompt = CLAUDE_USER_PROMPT_TEMPLATE.replace(
        '{{GEMINI_OUTPUT_JSON}}',
        JSON.stringify(geminiOutput, null, 2)
    );

    // withRetry: 529(Overloaded), 429(Rate Limit) 등 일시적 에러 시 자동 재시도
    const message = await withRetry('Claude 글쓰기', () =>
        anthropic.messages.create({
            model: "claude-sonnet-4-5", // 빌링 콘솔에 명시된 정확한 모델명
            max_tokens: 4096,
            temperature: 0.7,
            system: CLAUDE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
        })
    );

    const responseText = getFirstTextBlock(message.content);
    const parsedData = parseJsonText(responseText, 'Claude 글쓰기');

    // Gemini 메타정보 보강
    if (!parsedData.meta) parsedData.meta = {};
    parsedData.meta.sources_used = parsedData.meta.sources_used || geminiOutput.sources_used || [];
    parsedData.meta.source_count = parsedData.meta.source_count || geminiOutput.source_count || 0;
    parsedData.meta.theme_category = parsedData.meta.theme_category || geminiOutput.theme_category;
    parsedData.meta.theme_label = parsedData.meta.theme_label || geminiOutput.theme_label;

    return parsedData;
}

// ── STEP 2.5: Gemini 팩트체크 리뷰 ──
export async function step_review(articleData, originalFacts) {
    const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

    let promptWithData = GEMINI_REVIEW_PROMPT.replace(
        '{{FACTS_JSON}}',
        JSON.stringify(originalFacts, null, 2)
    );
    
    promptWithData = promptWithData.replace(
        '{{ARTICLE_JSON}}',
        JSON.stringify(articleData, null, 2)
    );

    const result = await withRetry('Gemini 팩트체크', () =>
        ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            contents: promptWithData,
            config: {
                responseMimeType: "application/json",
                temperature: 0.2,
            },
        })
    );
    const responseText = result.text;
    console.log(`[Gemini 리뷰] 응답 타입: ${typeof responseText}, 길이: ${typeof responseText === 'string' ? responseText.length : 'N/A'}`);
    let reviewOutput = parseJsonText(responseText, 'Gemini 리뷰');

    // 배열로 반환된 경우 첫 번째 객체 사용
    if (Array.isArray(reviewOutput)) {
        console.log('[Gemini 리뷰] 배열이 반환됨. 첫 번째 요소를 사용합니다.');
        reviewOutput = reviewOutput[0] || articleData; // 실패 시 원본 반환
    }

    return reviewOutput;
}

// ── STEP 3: 저장 & 알림 ──
export async function step3_save(finalData) {
    let notionUrl = null;
    let notionError = null;
    let slackError = null;

    try {
        notionUrl = await saveToNotion(finalData);
    } catch (e) {
        notionError = e.message;
        console.error('[STEP 3] Notion 저장 실패:', e.message);
    }

    try {
        await sendSlackNotification(finalData, notionUrl);
    } catch (e) {
        slackError = e.message;
        console.error('[STEP 3] Slack 전송 실패:', e.message);
    }

    return { notionUrl, notionError, slackError };
}

// ── 전체 파이프라인 (Cron용 — 한 번에 실행) ──
export async function runFullPipeline(keyword = null) {
    const articles = await scrapeSources(keyword);
    const geminiOutput = await step1_preprocess(articles, keyword);
    if (geminiOutput.error) {
        await sendSlackNotification(geminiOutput, null);
        return { error: geminiOutput };
    }
    const finalData = await step2_write(geminiOutput);
    const reviewedData = await step_review(finalData, geminiOutput);
    const saveResult = await step3_save(reviewedData);
    return { finalData: reviewedData, ...saveResult };
}

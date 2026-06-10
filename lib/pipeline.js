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
        // BOM(Byte Order Mark) 제거 — Claude가 간헐적으로 BOM을 포함하는 경우
        .replace(/^\uFEFF/, '')
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    // 유니코드 제어문자 제거 (줄바꿈·탭 제외)
    cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        
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
    // 왜: Claude가 본문(deepdive, lifestyle 등)에 실제 줄바꿈을 넣는 경우가 잦음
    // "key": "값 중간에
    // 줄바꿈이 있으면" → "key": "값 중간에\\n줄바꿈이 있으면"
    repaired = repaired.replace(/"([^"]*)\n([^"]*?)"/g, (match) => {
        return match.replace(/\n/g, '\\n');
    });
    // 여러 줄에 걸친 경우 반복 적용 (최대 20회 — 600~800자 본문은 줄바꿈이 많을 수 있음)
    for (let i = 0; i < 20; i++) {
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

    // 5단계: 이스케이프되지 않은 따옴표 복구
    // 왜: Claude가 문자열 값 내에서 "SCA 점수("국제 커피 품질 등급")" 처럼
    //     이스케이프 없이 따옴표를 사용하면 JSON이 깨짐
    // 전략: 줄 단위로 처리 — "key": "value" 패턴의 value 내부 따옴표만 이스케이프
    repaired = repaired.replace(
        /("[^"]+"\s*:\s*")([\s\S]*?)(?="\s*[,}\]])/g,
        (match, prefix, value) => {
            // value 내부의 이스케이프되지 않은 따옴표를 \" 로 변환
            const fixedValue = value.replace(/(?<!\\)"/g, '\\"');
            return prefix + fixedValue;
        }
    );

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
        console.warn(`[${label}] 1차 JSON 파싱 실패 (${firstError.message}), 복구 시도 중...`);

        // 2차 시도: repairJson으로 복구 후 파싱
        try {
            const repaired = repairJson(cleanedText);
            parsedResult = JSON.parse(repaired);
            console.log(`[${label}] ✅ JSON 복구 성공! (repairJson)`);
        } catch (secondError) {
            console.warn(`[${label}] 2차 복구 실패 (${secondError.message}), JSON 블록 추출 시도...`);

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
                console.warn(`[${label}] 3차 블록 추출 실패, 강제 줄바꿈 치환 시도...`);

                // 4차 시도: 모든 실제 줄바꿈을 \n 리터럴로 강제 변환 후 파싱
                // 왜: repairJson의 정규식이 복잡한 다중 줄바꿈 패턴을 놓칠 수 있음
                try {
                    let aggressive = cleanedText;
                    // 모든 \r\n 또는 \r 을 \n으로 통일
                    aggressive = aggressive.replace(/\r\n?/g, '\n');
                    // JSON 구조 밖의 줄바꿈은 유지, 문자열 값 내부의 줄바꿈만 치환
                    // 전략: 줄바꿈을 일단 모두 placeholder로 변경 → 파싱 → 복원
                    aggressive = aggressive.replace(/\n/g, '\\n');
                    // 다만 key-value 구분자 주변의 \n은 다시 실제 줄바꿈으로 복원
                    aggressive = aggressive.replace(/\\n\s*"([^"]+)"\s*:/g, '\n"$1":');
                    aggressive = aggressive.replace(/,\\n/g, ',\n');
                    aggressive = aggressive.replace(/\{\\n/g, '{\n');
                    aggressive = aggressive.replace(/\[\\n/g, '[\n');
                    aggressive = aggressive.replace(/\\n\}/g, '\n}');
                    aggressive = aggressive.replace(/\\n\]/g, '\n]');
                    // 후행 쉼표 재제거
                    aggressive = aggressive.replace(/,\s*([}\]])/g, '$1');
                    parsedResult = JSON.parse(aggressive);
                    console.log(`[${label}] ✅ 강제 줄바꿈 치환 후 파싱 성공!`);
                } catch (fourthError) {
                    // 최종 실패 시 상세 디버그 로그
                    const match = firstError.message.match(/position (\d+)/);
                    if (match) {
                        const pos = parseInt(match[1], 10);
                        const start = Math.max(0, pos - 100);
                        const end = Math.min(cleanedText.length, pos + 100);
                        console.error(`[${label}] JSON 파싱 최종 실패 위치(pos ${pos}) 주변 텍스트:\n---\n${cleanedText.substring(start, end)}\n---`);
                    }
                    // 전체 응답의 앞·뒤 부분 로그 (원인 파악용)
                    console.error(`[${label}] 원본 응답 앞부분(500자):`, cleanedText.substring(0, 500));
                    console.error(`[${label}] 원본 응답 뒷부분(200자):`, cleanedText.substring(cleanedText.length - 200));
                    throw new Error(`${label} JSON 파싱 실패: ${firstError.message}`);
                }
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

// ── Claude Tool Use 스키마 정의 ──
// 왜 Tool Use를 사용하는가: Claude에게 "JSON으로만 출력하라"고 지시해도,
// 긴 텍스트 생성 시 문자열 내부에 이스케이프되지 않은 줄바꿈·따옴표가 포함되어
// JSON.parse()가 실패하는 문제가 반복적으로 발생함.
// Tool Use를 사용하면 Claude SDK가 JSON Schema를 강제하므로 파싱 오류가 원천 차단됨.
const ARTICLE_TOOL = {
    name: "publish_article",
    description: "완성된 매거진 칼럼 데이터를 구조화된 형태로 제출합니다.",
    input_schema: {
        type: "object",
        properties: {
            meta: {
                type: "object",
                properties: {
                    generated_at: { type: "string", description: "생성 날짜 (YYYY-MM-DD)" },
                    theme_category: { type: "string", description: "A~E 테마 카테고리" },
                    theme_label: { type: "string", description: "테마명" },
                    source_count: { type: "number", description: "사용 소스 수" },
                    sources_used: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                source: { type: "string" },
                                title: { type: "string" },
                                link: { type: "string" },
                            },
                            required: ["source", "title"],
                        },
                    },
                },
                required: ["generated_at", "theme_category", "theme_label"],
            },
            article: {
                type: "object",
                properties: {
                    title: { type: "string", description: "아티클 제목 (30자 내외)" },
                    subtitle: { type: "string", description: "부제목 (20자 내외)" },
                    intro: { type: "string", description: "오늘의 한 잔 — 인트로 본문" },
                    deepdive: { type: "string", description: "트렌드 브리핑 — 딥다이브 본문" },
                    lifestyle: { type: "string", description: "내 한 잔에 어떤 의미? — 일상 해석 본문" },
                    action_tips: {
                        type: "array",
                        items: { type: "string" },
                        description: "실천 팁 2~3개",
                    },
                    editor_comment: { type: "string", description: "에디터 코멘트" },
                },
                required: ["title", "subtitle", "intro", "deepdive", "lifestyle", "action_tips", "editor_comment"],
            },
            taxonomy: {
                type: "object",
                properties: {
                    hashtags: {
                        type: "array",
                        items: { type: "string" },
                        description: "#태그 3~5개",
                    },
                },
                required: ["hashtags"],
            },
            notification: {
                type: "object",
                properties: {
                    slack_summary: {
                        type: "array",
                        items: { type: "string" },
                        description: "슬랙 요약 3개",
                    },
                    slack_insight: { type: "string", description: "인사이트 (50자 내외)" },
                },
                required: ["slack_summary", "slack_insight"],
            },
            sns_content: {
                type: "object",
                properties: {
                    card_news: {
                        type: "array",
                        items: { type: "string" },
                        description: "카드뉴스 슬라이드 5장",
                    },
                },
                required: ["card_news"],
            },
        },
        required: ["meta", "article", "taxonomy", "notification", "sns_content"],
    },
};

// ── STEP 2: Claude 글쓰기 ──
export async function step2_write(geminiOutput) {
    const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

    const userPrompt = CLAUDE_USER_PROMPT_TEMPLATE.replace(
        '{{GEMINI_OUTPUT_JSON}}',
        JSON.stringify(geminiOutput, null, 2)
    );

    // ── 방법 1: Tool Use로 구조화된 JSON 응답 강제 ──
    // tool_choice: "any"로 설정하면 Claude가 반드시 도구를 호출하도록 강제함
    // 이렇게 하면 응답이 JSON Schema에 맞춰 구조화되어 파싱 오류가 원천 차단됨
    let parsedData = null;

    try {
        console.log('[Claude 글쓰기] Tool Use 방식으로 호출 중...');
        const message = await withRetry('Claude 글쓰기 (Tool Use)', () =>
            anthropic.messages.create({
                model: "claude-sonnet-4-5",
                max_tokens: 8192,
                temperature: 0.7,
                system: CLAUDE_SYSTEM_PROMPT,
                tools: [ARTICLE_TOOL],
                tool_choice: { type: "tool", name: "publish_article" },
                messages: [{ role: "user", content: userPrompt }],
            })
        );

        console.log(`[Claude 글쓰기] stop_reason: ${message.stop_reason}`);

        // Tool Use 응답에서 tool_use 블록의 input 추출
        const toolUseBlock = message.content.find(block => block.type === 'tool_use');
        if (toolUseBlock && toolUseBlock.input) {
            parsedData = toolUseBlock.input;
            console.log('[Claude 글쓰기] ✅ Tool Use 방식으로 구조화된 JSON 수신 성공!');
        } else {
            console.warn('[Claude 글쓰기] ⚠️ Tool Use 블록을 찾을 수 없음, 텍스트 폴백 시도...');
        }
    } catch (toolError) {
        console.warn(`[Claude 글쓰기] ⚠️ Tool Use 방식 실패 (${toolError.message}), 텍스트 폴백 시도...`);
    }

    // ── 방법 2: 폴백 — 기존 텍스트 방식 (Tool Use 실패 시에만 실행) ──
    if (!parsedData) {
        console.log('[Claude 글쓰기] 텍스트 방식으로 재시도 중...');
        const fallbackMessage = await withRetry('Claude 글쓰기 (텍스트 폴백)', () =>
            anthropic.messages.create({
                model: "claude-sonnet-4-5",
                max_tokens: 8192,
                temperature: 0.7,
                system: CLAUDE_SYSTEM_PROMPT,
                messages: [{ role: "user", content: userPrompt }],
            })
        );

        const responseText = getFirstTextBlock(fallbackMessage.content);
        console.log(`[Claude 글쓰기] 폴백 응답 길이: ${responseText.length}자, stop_reason: ${fallbackMessage.stop_reason}`);

        if (fallbackMessage.stop_reason !== 'end_turn') {
            console.warn(`[Claude 글쓰기] ⚠️ stop_reason이 '${fallbackMessage.stop_reason}' — 응답이 잘렸을 수 있음`);
        }

        parsedData = parseJsonText(responseText, 'Claude 글쓰기');
    }

    // Gemini 메타정보 보강
    if (!parsedData.meta) parsedData.meta = {};
    parsedData.meta.sources_used = parsedData.meta.sources_used || geminiOutput.sources_used || [];
    parsedData.meta.source_count = parsedData.meta.source_count || geminiOutput.source_count || 0;
    parsedData.meta.theme_category = parsedData.meta.theme_category || geminiOutput.theme_category;
    parsedData.meta.theme_label = parsedData.meta.theme_label || geminiOutput.theme_label;

    return parsedData;
}

// ── STEP 2.5: Gemini 팩트체크 리뷰 ──
// 왜 검증이 필요한가: Gemini가 "동일한 JSON 구조를 유지하라"는 지시를 받아도,
// 실제로는 구조를 변형(추가 필드, 감싸기, 키 누락)하는 경우가 빈번하여
// 이후 Notion 저장 시 빈 페이지가 생성되는 치명적 버그를 유발함.
const REVIEW_REQUIRED_KEYS = ['meta', 'article', 'taxonomy'];
const REVIEW_REQUIRED_ARTICLE_KEYS = ['title', 'deepdive', 'lifestyle'];

function validateReviewStructure(data) {
    if (!data || typeof data !== 'object') return false;
    const hasTopKeys = REVIEW_REQUIRED_KEYS.every(key => data[key] && typeof data[key] === 'object');
    if (!hasTopKeys) return false;
    const hasArticleKeys = REVIEW_REQUIRED_ARTICLE_KEYS.every(
        key => typeof data.article[key] === 'string' && data.article[key].trim().length > 0
    );
    return hasArticleKeys;
}

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

    let reviewOutput;

    try {
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
        reviewOutput = parseJsonText(responseText, 'Gemini 리뷰');

        // 배열로 반환된 경우 첫 번째 객체 사용
        if (Array.isArray(reviewOutput)) {
            console.log('[Gemini 리뷰] 배열이 반환됨. 첫 번째 요소를 사용합니다.');
            reviewOutput = reviewOutput[0];
        }
    } catch (reviewError) {
        // Gemini 리뷰 호출 자체가 실패하면 원본을 그대로 사용
        console.warn(`[Gemini 리뷰] ⚠️ 팩트체크 호출 실패 (${reviewError.message}). 원본 데이터를 사용합니다.`);
        return articleData;
    }

    // ── 핵심 방어 로직: 반환값 구조 검증 ──
    // Gemini가 구조를 변형하면 Notion에 빈 페이지가 저장되므로, 원본(Claude 원고) 사용으로 폴백
    if (!validateReviewStructure(reviewOutput)) {
        console.warn('[Gemini 리뷰] ⚠️ 반환값 구조가 유효하지 않음! 원본 데이터를 사용합니다.');
        console.warn('[Gemini 리뷰] 반환된 최상위 키:', Object.keys(reviewOutput || {}));
        console.warn('[Gemini 리뷰] article 키:', Object.keys(reviewOutput?.article || {}));
        return articleData;
    }

    console.log('[Gemini 리뷰] ✅ 구조 검증 통과. 리뷰된 데이터를 사용합니다.');
    return reviewOutput;
}

// ── STEP 3: 저장 & 알림 ──
export async function step3_save(finalData) {
    let notionUrl = null;
    let notionError = null;
    let slackError = null;

    // 빈 데이터 방어: Notion에 빈 페이지가 생성되는 것을 사전 차단
    if (!finalData?.article?.title || !finalData?.article?.deepdive) {
        const missingFields = [];
        if (!finalData?.article) missingFields.push('article 객체 전체');
        else {
            if (!finalData.article.title) missingFields.push('article.title');
            if (!finalData.article.deepdive) missingFields.push('article.deepdive');
        }
        console.error(`[STEP 3] ❌ finalData 필수 필드 누락: ${missingFields.join(', ')}`);
        console.error('[STEP 3] finalData 최상위 키:', Object.keys(finalData || {}));
        return {
            notionUrl: null,
            notionError: `필수 데이터 누락 (${missingFields.join(', ')}). 노션 저장을 건너뜁니다.`,
            slackError: null,
        };
    }

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

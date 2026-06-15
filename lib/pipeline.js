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
// ⚠️ Vercel Hobby 플랜 60초 제한에 맞춰, 재시도 총 대기 시간이 10초를 넘지 않도록 설정
const RETRY_CONFIG = {
    maxRetries: 2,         // 최대 재시도 횟수 (3→2로 축소, 60초 제한 대응)
    baseDelayMs: 2000,     // 기본 대기 시간 (5초→2초로 단축)
    maxDelayMs: 10000,     // 최대 대기 시간 (30초→10초로 단축)
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

// Vercel Hobby 플랜 60초 제한 → 개별 AI 호출은 55초 이내에 완료해야 함 (최대 여유 확보)
const CALL_TIMEOUT_MS = 55000;

// API 호출을 재시도 가능하게 감싸는 래퍼 함수
// ✅ 각 호출에 40초 하드 타임아웃을 적용하여 Vercel 504를 방지
async function withRetry(label, apiCallFn) {
    let lastError;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
            // ✅ 핵심: 각 API 호출에 하드 타임아웃 적용
            // Vercel 함수 60초 제한 전에 반드시 응답을 받기 위함
            return await Promise.race([
                apiCallFn(),
                new Promise((_, reject) =>
                    setTimeout(() => {
                        const err = new Error(`${label}: AI 응답 대기 ${CALL_TIMEOUT_MS / 1000}초 초과`);
                        err._isCallTimeout = true;
                        reject(err);
                    }, CALL_TIMEOUT_MS)
                )
            ]);
        } catch (error) {
            lastError = error;

            // 타임아웃은 재시도해도 같은 결과이므로 즉시 실패 처리
            if (error._isCallTimeout) {
                console.error(`[${label}] ❌ AI 호출 타임아웃 (${CALL_TIMEOUT_MS / 1000}초 초과). 재시도하지 않습니다.`);
                throw error;
            }

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
            model: "gemini-2.5-flash",
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

    // gemini-2.5-flash: Pro 대비 3~5배 빠른 응답 (Vercel Hobby 60초 제한 대응)
    const result = await withRetry('Gemini 전처리', () =>
        ai.models.generateContent({
            model: "gemini-2.5-flash",
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
                        items: {
                            type: "object",
                            properties: {
                                slide: { type: "number", description: "슬라이드 번호 (1~5)" },
                                type: { type: "string", description: "슬라이드 유형 (표지/상황/인사이트/실천/마무리)" },
                                text: { type: "string", description: "카드에 들어갈 카피 텍스트" },
                                image_guide: { type: "string", description: "디자이너를 위한 이미지 연출 가이드 (배경, 색상, 오브제, 앵글 등)" },
                            },
                            required: ["slide", "type", "text", "image_guide"],
                        },
                        description: "인스타그램 카드뉴스 슬라이드 5장 (텍스트 + 이미지 가이드)",
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
                model: "claude-haiku-4-5",
                max_tokens: 4096,
                temperature: 0.5,
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
        // 타임아웃이면 폴백(2차 호출)도 시간이 부족하므로 즉시 실패
        if (toolError._isCallTimeout) {
            throw toolError;
        }
        console.warn(`[Claude 글쓰기] ⚠️ Tool Use 방식 실패 (${toolError.message}), 텍스트 폴백 시도...`);
    }

    // ── 방법 2: 폴백 — 기존 텍스트 방식 (Tool Use 실패 시에만 실행) ──
    if (!parsedData) {
        console.log('[Claude 글쓰기] 텍스트 방식으로 재시도 중...');
        const fallbackMessage = await withRetry('Claude 글쓰기 (텍스트 폴백)', () =>
            anthropic.messages.create({
                model: "claude-haiku-4-5",
                max_tokens: 4096,
                temperature: 0.5,
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

    // 방어 로직 1: Claude가 간혹 최상위 키를 도구 이름(publish_article)으로 감싸서 반환하는 경우 구조 해제
    if (parsedData && parsedData.publish_article) {
        console.warn('[Claude 글쓰기] ⚠️ 최상위 키가 publish_article로 감싸져 있어 해제합니다.');
        parsedData = parsedData.publish_article;
    }

    if (!parsedData || typeof parsedData !== 'object') {
        parsedData = {};
    }

    // ── 방어 로직 2: JSON Inception (전체 JSON이 문자열로 갇힌 경우) 해제 ──
    const keys = Object.keys(parsedData);
    if (keys.length === 1 && typeof parsedData[keys[0]] === 'string') {
        const rawString = parsedData[keys[0]].trim();
        if (rawString.startsWith('{') && rawString.endsWith('}')) {
            try {
                // 이스케이프 문자 등 정리 후 파싱
                let cleanRaw = rawString.replace(/\\n/g, '\n').replace(/\\"/g, '"');
                const innerJson = JSON.parse(cleanRaw);
                if (innerJson && typeof innerJson === 'object') {
                    console.warn(`[Claude 글쓰기] ⚠️ 단일 키(${keys[0]}) 내부에 갇힌 전체 JSON 텍스트 발견! 껍질을 깹니다.`);
                    parsedData = innerJson;
                }
            } catch (e) {
                // JSON 파싱 실패 시 원본 문자열을 그대로 사용
            }
        }
    }

    // ── 궁극의 방어 로직: 재귀적으로 키 찾기 ──
    // LLM이 구조를 어떻게 망가뜨려도(이중 감싸기, 배열화, 키 이름 변경 등) 값을 찾아냄
    const findField = (obj, keyName, isArray = false) => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj[keyName]) {
            if (isArray && Array.isArray(obj[keyName]) && obj[keyName].length > 0) return obj[keyName];
            if (!isArray && typeof obj[keyName] === 'string' && obj[keyName].trim().length > 0) return obj[keyName];
        }
        for (const k of Object.keys(obj)) {
            const found = findField(obj[k], keyName, isArray);
            if (found) return found;
        }
        return null;
    };

    if (!parsedData.article || typeof parsedData.article !== 'object') {
        const tempString = typeof parsedData.article === 'string' ? parsedData.article : '';
        parsedData.article = {};
        if (tempString) parsedData.article.deepdive = tempString;
    }

    // 1. 문자열 필드 복구
    const extTitle = findField(parsedData, 'title') || findField(parsedData, '제목');
    const extDeepdive = findField(parsedData, 'deepdive') || findField(parsedData, '트렌드 브리핑') || findField(parsedData, '본문');
    const extIntro = findField(parsedData, 'intro') || findField(parsedData, '오늘의 한 잔') || findField(parsedData, '서론');
    const extSubtitle = findField(parsedData, 'subtitle') || findField(parsedData, '부제목');
    const extLifestyle = findField(parsedData, 'lifestyle') || findField(parsedData, '내 한 잔에 어떤 의미');
    const extEditor = findField(parsedData, 'editor_comment') || findField(parsedData, '에디터 코멘트');
    const extSlackInsight = findField(parsedData, 'slack_insight') || findField(parsedData, '인사이트');

    // 2. 배열 필드 복구
    const extActionTips = findField(parsedData, 'action_tips', true) || findField(parsedData, '이렇게 즐겨보세요', true);
    const extHashtags = findField(parsedData, 'hashtags', true) || findField(parsedData, '해시태그', true);
    const extSlackSummary = findField(parsedData, 'slack_summary', true) || findField(parsedData, '슬랙 요약', true);
    const extCardNews = findField(parsedData, 'card_news', true) || findField(parsedData, '카드뉴스', true) || findField(parsedData, 'sns_content', true);

    parsedData.article.title = extTitle || parsedData.article.title || "커피 산업 트렌드 브리핑";
    parsedData.article.deepdive = extDeepdive || parsedData.article.deepdive || "최근 커피 업계에 다양한 변화가 감지되고 있습니다. 상세한 분석 내용을 수집 중입니다.";
    if (extIntro) parsedData.article.intro = extIntro;
    if (extSubtitle) parsedData.article.subtitle = extSubtitle;
    if (extLifestyle) parsedData.article.lifestyle = extLifestyle;
    if (extEditor) parsedData.article.editor_comment = extEditor;
    if (extActionTips) parsedData.article.action_tips = extActionTips;

    if (!parsedData.taxonomy) parsedData.taxonomy = {};
    if (extHashtags) parsedData.taxonomy.hashtags = extHashtags;

    if (!parsedData.notification) parsedData.notification = {};
    if (extSlackSummary) parsedData.notification.slack_summary = extSlackSummary;
    if (extSlackInsight) parsedData.notification.slack_insight = extSlackInsight;

    if (!parsedData.sns_content) parsedData.sns_content = {};
    if (extCardNews) parsedData.sns_content.card_news = extCardNews;

    console.log('[Claude 글쓰기] ✅ 구조 복원 완료. (title:', parsedData.article.title.substring(0, 15) + '...)');

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
                model: "gemini-2.5-flash",
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

    // 방어 로직: 혹시 최상위 키가 reviewOutput 등으로 감싸져 있는 경우 해제
    if (reviewOutput && !reviewOutput.article && Object.keys(reviewOutput).length === 1) {
        const firstKey = Object.keys(reviewOutput)[0];
        if (reviewOutput[firstKey] && reviewOutput[firstKey].article) {
            console.warn(`[Gemini 리뷰] ⚠️ 최상위 키(${firstKey})로 감싸져 있어 해제합니다.`);
            reviewOutput = reviewOutput[firstKey];
        }
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

    // ── 핵심 방어 로직: Gemini가 누락시킨 필드를 원본(Claude 출력물)에서 복원 ──
    // 왜 필요한가: Gemini가 팩트체크에만 집중하면서 sns_content, notification 등
    // 팩트체크와 무관한 필드를 응답에서 빼먹는 경우가 빈번함.
    // 이 경우 카드뉴스 대본, 슬랙 알림 데이터가 사라지는 치명적 버그 발생.
    //
    // ⚠️ 기존 버그: `!reviewOutput[field]`로 최상위 키만 체크하면,
    // Gemini가 `sns_content: {}` (빈 객체)를 반환할 때 복원이 안 됨.
    // → 내부 핵심 필드(card_news 등)까지 깊게 체크해야 함.
    const fieldsToPreserve = ['sns_content', 'notification', 'taxonomy'];
    for (const field of fieldsToPreserve) {
        if (!reviewOutput[field] && articleData[field]) {
            console.warn(`[Gemini 리뷰] ⚠️ '${field}' 필드가 리뷰 결과에서 누락됨 → 원본에서 복원합니다.`);
            reviewOutput[field] = articleData[field];
        }
    }

    // ── 깊은 복원: 최상위 키는 있지만 내부 핵심 데이터가 빈 경우 ──
    // 왜: Gemini가 `sns_content: {}` 또는 `sns_content: { card_news: [] }` 처럼
    // 껍데기만 남기고 실제 데이터를 비우는 경우가 반복적으로 발생
    const cardNews = reviewOutput.sns_content?.card_news;
    const originalCardNews = articleData.sns_content?.card_news;
    if ((!Array.isArray(cardNews) || cardNews.length === 0) && Array.isArray(originalCardNews) && originalCardNews.length > 0) {
        console.warn('[Gemini 리뷰] ⚠️ sns_content.card_news가 비어있음 → 원본에서 복원합니다.');
        if (!reviewOutput.sns_content) reviewOutput.sns_content = {};
        reviewOutput.sns_content.card_news = originalCardNews;
    }

    // notification.slack_summary도 동일 패턴으로 방어
    const slackSummary = reviewOutput.notification?.slack_summary;
    const originalSlackSummary = articleData.notification?.slack_summary;
    if ((!Array.isArray(slackSummary) || slackSummary.length === 0) && Array.isArray(originalSlackSummary) && originalSlackSummary.length > 0) {
        console.warn('[Gemini 리뷰] ⚠️ notification.slack_summary가 비어있음 → 원본에서 복원합니다.');
        if (!reviewOutput.notification) reviewOutput.notification = {};
        reviewOutput.notification.slack_summary = originalSlackSummary;
    }

    // taxonomy.hashtags 방어
    const hashtags = reviewOutput.taxonomy?.hashtags;
    const originalHashtags = articleData.taxonomy?.hashtags;
    if ((!Array.isArray(hashtags) || hashtags.length === 0) && Array.isArray(originalHashtags) && originalHashtags.length > 0) {
        console.warn('[Gemini 리뷰] ⚠️ taxonomy.hashtags가 비어있음 → 원본에서 복원합니다.');
        if (!reviewOutput.taxonomy) reviewOutput.taxonomy = {};
        reviewOutput.taxonomy.hashtags = originalHashtags;
    }

    // meta.sources_used도 Gemini가 빼먹을 수 있으므로 복원
    if (reviewOutput.meta && articleData.meta) {
        if (!reviewOutput.meta.sources_used && articleData.meta.sources_used) {
            reviewOutput.meta.sources_used = articleData.meta.sources_used;
        }
    }

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
        console.log('[STEP 3] ✅ Notion 저장 성공:', notionUrl);
    } catch (e) {
        // 왜 상세 로그를 남기는가: 노션 저장이 조용히 실패하면
        // 슬랙에 "노션에서 전문 읽기" 링크가 빠지는 버그로 이어짐
        notionError = e.message;
        console.error('[STEP 3] ❌ Notion 저장 실패:', e.message);
        console.error('[STEP 3] 에러 상세:', e.status || 'N/A', e.code || 'N/A');
        if (e.body) console.error('[STEP 3] 에러 body:', JSON.stringify(e.body).substring(0, 500));
    }

    try {
        await sendSlackNotification(finalData, notionUrl);
        console.log('[STEP 3] ✅ Slack 전송 성공 (notionUrl:', notionUrl ? '포함' : '❌ 없음 — 링크 누락됨', ')');
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

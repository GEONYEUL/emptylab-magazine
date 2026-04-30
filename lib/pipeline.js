// lib/pipeline.js
// 공통 파이프라인 로직 — API 라우트에서 공유
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { scrapeSources } from './scraper.js';
import { GEMINI_PREPROCESS_PROMPT, CLAUDE_SYSTEM_PROMPT, CLAUDE_USER_PROMPT_TEMPLATE, GEMINI_EXTRACT_ISSUES_PROMPT, GEMINI_REVIEW_PROMPT } from './prompt.js';
import { saveToNotion } from './notion.js';
import { sendSlackNotification } from './slack.js';
import { requireEnv } from './env.js';

function cleanJsonText(text) {
    let cleaned = String(text || '')
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
        
    // 후행 쉼표(trailing comma) 제거: 객체나 배열의 마지막 요소 뒤에 있는 쉼표 제거
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    
    // 이스케이프되지 않은 개행문자 처리 (제한적)
    // 문자열 값 내부의 개행은 JSON 파싱 에러를 유발합니다.
    // 완벽한 처리는 어렵지만, 따옴표 사이의 줄바꿈을 이스케이프하는 로직은 복잡하므로,
    // 이전에 프롬프트에서 제어하도록 조치했습니다.
    
    return cleaned;
}

function parseJsonText(text, label) {
    const cleanedText = cleanJsonText(text);
    if (!cleanedText) throw new Error(`${label} returned an empty response`);

    try {
        return JSON.parse(cleanedText);
    } catch (error) {
        // 에러 위치 파악을 위한 로직
        const match = error.message.match(/position (\d+)/);
        if (match) {
            const pos = parseInt(match[1], 10);
            const start = Math.max(0, pos - 50);
            const end = Math.min(cleanedText.length, pos + 50);
            console.error(`[${label}] JSON 파싱 실패 위치 주변 텍스트:\n...${cleanedText.substring(start, end)}...`);
        } else {
            console.error(`[${label}] JSON 파싱 실패. 원본 응답:`, cleanedText.substring(0, 1000));
        }
        throw new Error(`${label} JSON 파싱 실패: ${error.message}`);
    }
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

    const genAI = new GoogleGenerativeAI(requireEnv('GEMINI_API_KEY'));

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

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
        },
    });

    const result = await model.generateContent(promptWithData);
    const responseText = result.response.text();
    return parseJsonText(responseText, 'Gemini 이슈 추출');
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

    const genAI = new GoogleGenerativeAI(requireEnv('GEMINI_API_KEY'));

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

    // 실제 존재하는 최신 Pro 모델로 변경 (3.1은 아직 API 지원이 안됨)
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
        },
    });

    const result = await model.generateContent(promptWithData);
    const responseText = result.response.text();
    const geminiOutput = parseJsonText(responseText, 'Gemini 전처리');

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

    const message = await anthropic.messages.create({
        model: "claude-sonnet-4-5", // 빌링 콘솔에 명시된 정확한 모델명
        max_tokens: 4096,
        temperature: 0.7,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
    });

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
    const genAI = new GoogleGenerativeAI(requireEnv('GEMINI_API_KEY'));

    let promptWithData = GEMINI_REVIEW_PROMPT.replace(
        '{{FACTS_JSON}}',
        JSON.stringify(originalFacts, null, 2)
    );
    
    promptWithData = promptWithData.replace(
        '{{ARTICLE_JSON}}',
        JSON.stringify(articleData, null, 2)
    );

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
        },
    });

    const result = await model.generateContent(promptWithData);
    const responseText = result.response.text();
    return parseJsonText(responseText, 'Gemini 리뷰');
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

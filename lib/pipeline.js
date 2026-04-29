// lib/pipeline.js
// 공통 파이프라인 로직 — API 라우트에서 공유
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { scrapeSources } from './scraper.js';
import { GEMINI_PREPROCESS_PROMPT, CLAUDE_SYSTEM_PROMPT, CLAUDE_USER_PROMPT_TEMPLATE } from './prompt.js';
import { saveToNotion } from './notion.js';
import { sendSlackNotification } from './slack.js';

// ── STEP 1: AI 전처리 (Claude 3.5 Haiku 사용) ──
export async function step1_preprocess(articles) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    if (!articles || articles.length < 3) {
        return {
            error: "INSUFFICIENT_DATA",
            message: "유효한 기사가 3개 미만입니다.",
            count: articles ? articles.length : 0,
        };
    }

    const promptWithData = GEMINI_PREPROCESS_PROMPT.replace(
        '{{ARTICLES_JSON}}',
        JSON.stringify(articles, null, 2)
    );

    // Gemini 무료 한도 문제로 인해 빠르고 저렴한 Claude 3.5 Haiku로 전처리 대체
    const message = await anthropic.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 2048,
        temperature: 0.3,
        system: "너는 커피/카페 산업 전문 데이터 분석 에이전트다. 반드시 유효한 JSON 형식으로만 응답하라. 마크다운 코드블록이나 다른 설명은 절대 포함하지 마라.",
        messages: [{ role: "user", content: promptWithData }]
    });

    const responseText = message.content[0].text;
    const cleanedText = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        const output = JSON.parse(cleanedText);
        if (output.error) return output;
        return output;
    } catch (e) {
        throw new Error(`전처리 JSON 파싱 실패: ${e.message}`);
    }
}

// ── STEP 2: Claude 글쓰기 ──
export async function step2_write(geminiOutput) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userPrompt = CLAUDE_USER_PROMPT_TEMPLATE.replace(
        '{{GEMINI_OUTPUT_JSON}}',
        JSON.stringify(geminiOutput, null, 2)
    );

    const message = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        temperature: 0.7,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
    });

    const responseText = message.content[0].text;
    const cleanedText = responseText
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsedData = JSON.parse(cleanedText);

    // Gemini 메타정보 보강
    if (!parsedData.meta) parsedData.meta = {};
    parsedData.meta.sources_used = parsedData.meta.sources_used || geminiOutput.sources_used || [];
    parsedData.meta.source_count = parsedData.meta.source_count || geminiOutput.source_count || 0;
    parsedData.meta.theme_category = parsedData.meta.theme_category || geminiOutput.theme_category;
    parsedData.meta.theme_label = parsedData.meta.theme_label || geminiOutput.theme_label;

    return parsedData;
}

// ── STEP 3: 저장 & 알림 ──
export async function step3_save(finalData) {
    let notionUrl = null;
    try {
        notionUrl = await saveToNotion(finalData);
    } catch (e) {
        console.error('[STEP 3] Notion 저장 실패:', e.message);
    }

    try {
        await sendSlackNotification(finalData, notionUrl);
    } catch (e) {
        console.error('[STEP 3] Slack 전송 실패:', e.message);
    }

    return { notionUrl };
}

// ── 전체 파이프라인 (Cron용 — 한 번에 실행) ──
export async function runFullPipeline(keyword = null) {
    const articles = await scrapeSources(keyword);
    const geminiOutput = await step1_preprocess(articles);
    if (geminiOutput.error) {
        await sendSlackNotification(geminiOutput, null);
        return { error: geminiOutput };
    }
    const finalData = await step2_write(geminiOutput);
    const { notionUrl } = await step3_save(finalData);
    return { finalData, notionUrl };
}

// lib/pipeline.js
// 공통 파이프라인 로직 — API 라우트에서 공유
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { scrapeSources } from './scraper.js';
import { GEMINI_PREPROCESS_PROMPT, CLAUDE_SYSTEM_PROMPT, CLAUDE_USER_PROMPT_TEMPLATE } from './prompt.js';
import { saveToNotion } from './notion.js';
import { sendSlackNotification } from './slack.js';

// ── STEP 1: Gemini 전처리 ──
export async function step1_preprocess(articles) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

    // gemini-2.0-flash: 무료 한도 1,500회/일
    const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
        },
    });

    const result = await model.generateContent(promptWithData);
    const geminiOutput = JSON.parse(result.response.text());

    if (geminiOutput.error) return geminiOutput;
    return geminiOutput;
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

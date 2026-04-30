// app/api/preprocess/route.js
// STEP 1: Gemini 전처리
import { step1_preprocess } from '../../../lib/pipeline.js';
import { badRequest, normalizeKeyword, readJsonBody } from '../../../lib/api.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const body = await readJsonBody(request);
        if (!body) return badRequest('Invalid JSON body');

        const { articles } = body;
        if (!Array.isArray(articles)) return badRequest('articles must be an array');

        const keyword = normalizeKeyword(body.keyword);
        if (keyword?.error) return badRequest(keyword.error);

        console.log(`[API/preprocess] Gemini 전처리 시작 (${articles.length}건, 키워드: ${keyword || '전체'})`);

        const geminiOutput = await step1_preprocess(articles, keyword);

        return Response.json({
            success: !geminiOutput.error,
            step: 'preprocess',
            data: geminiOutput,
        });
    } catch (error) {
        console.error('[API/preprocess] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

// app/api/preprocess/route.js
// STEP 1: Gemini 전처리
import { step1_preprocess } from '../../../lib/pipeline.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const { articles } = await request.json();
        console.log(`[API/preprocess] Gemini 전처리 시작 (${articles.length}건)`);

        const geminiOutput = await step1_preprocess(articles);

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

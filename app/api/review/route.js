import { step_review } from '../../../lib/pipeline.js';
import { badRequest, readJsonBody } from '../../../lib/api.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const body = await readJsonBody(request);
        if (!body) return badRequest('Invalid JSON body');

        const { articleData, originalFacts } = body;
        if (!articleData) return badRequest('articleData is required');
        if (!originalFacts) return badRequest('originalFacts is required');

        console.log(`[API/review] Gemini 팩트체크 리뷰 시작`);

        const reviewedData = await step_review(articleData, originalFacts);

        return Response.json({
            success: true,
            step: 'review',
            data: reviewedData,
        });
    } catch (error) {
        console.error('[API/review] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

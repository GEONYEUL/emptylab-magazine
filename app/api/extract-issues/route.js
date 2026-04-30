import { step_extract_issues } from '../../../lib/pipeline.js';
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

        console.log(`[API/extract-issues] Gemini 이슈 추출 시작 (${articles.length}건, 키워드: ${keyword || '전체'})`);

        const issuesOutput = await step_extract_issues(articles, keyword);

        return Response.json({
            success: !issuesOutput.error,
            step: 'extract-issues',
            data: issuesOutput,
        });
    } catch (error) {
        console.error('[API/extract-issues] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

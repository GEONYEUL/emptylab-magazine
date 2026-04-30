// app/api/save/route.js
// STEP 3: Notion 저장 + Slack 알림
import { step3_save } from '../../../lib/pipeline.js';
import { badRequest, isPlainObject, readJsonBody } from '../../../lib/api.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const body = await readJsonBody(request);
        if (!body) return badRequest('Invalid JSON body');

        const { finalData } = body;
        if (!isPlainObject(finalData)) return badRequest('finalData must be an object');
        if (finalData.error) return badRequest('finalData contains an error', finalData);

        console.log('[API/save] Notion 저장 + Slack 알림 시작...');

        const result = await step3_save(finalData);

        return Response.json({
            success: Boolean(result.notionUrl),
            step: 'save',
            ...result,
        });
    } catch (error) {
        console.error('[API/save] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

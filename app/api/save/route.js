// app/api/save/route.js
// STEP 3: Notion 저장 + Slack 알림
import { step3_save } from '../../../lib/pipeline.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const { finalData } = await request.json();
        console.log('[API/save] Notion 저장 + Slack 알림 시작...');

        const { notionUrl } = await step3_save(finalData);

        return Response.json({
            success: true,
            step: 'save',
            notionUrl,
        });
    } catch (error) {
        console.error('[API/save] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

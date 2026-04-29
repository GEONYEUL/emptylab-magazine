// app/api/cron/route.js
// Vercel Cron Job — 매일 자동 실행
import { runFullPipeline } from '../../../lib/pipeline.js';

export const maxDuration = 10;

export async function GET(request) {
    // Vercel Cron 인증 (보안)
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        console.log('[CRON] 자동 파이프라인 실행 시작');
        const result = await runFullPipeline();

        return Response.json({
            success: !result.error,
            title: result.finalData?.article?.title || null,
            notionUrl: result.notionUrl || null,
        });
    } catch (error) {
        console.error('[CRON] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

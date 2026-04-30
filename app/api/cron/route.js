// app/api/cron/route.js
// Vercel Cron Job — 매일 자동 실행
import { runFullPipeline } from '../../../lib/pipeline.js';

// Cron은 수집~전처리~글쓰기~저장 전 과정을 한 번에 실행하므로 충분한 시간 필요
export const maxDuration = 60;

export async function GET(request) {
    // Vercel Cron 인증
    // Vercel은 CRON_SECRET 환경변수가 설정되어 있으면
    // Cron 호출 시 자동으로 `Authorization: Bearer <CRON_SECRET>` 헤더를 추가함
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        console.error('[CRON] ❌ 인증 실패 — 헤더:', authHeader?.substring(0, 20) || '없음');
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        console.log(`[CRON] 🕘 자동 파이프라인 실행 시작 — ${new Date().toISOString()}`);
        const result = await runFullPipeline();

        if (result.error) {
            console.error('[CRON] ⚠️ 파이프라인 경고:', result.error.message || result.error);
            return Response.json({ success: false, error: result.error }, { status: 200 });
        }

        console.log(`[CRON] ✅ 성공 — ${result.finalData?.article?.title}`);
        return Response.json({
            success: !result.notionError && !result.slackError,
            title: result.finalData?.article?.title || null,
            notionUrl: result.notionUrl || null,
            notionError: result.notionError || null,
            slackError: result.slackError || null,
        });
    } catch (error) {
        console.error('[CRON] ❌ 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

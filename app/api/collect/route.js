// app/api/collect/route.js
// STEP 0: 뉴스 수집 (키워드 필터 지원)
import { scrapeSources } from '../../../lib/scraper.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const { keyword } = await request.json();
        console.log(`[API/collect] 수집 시작 (keyword: ${keyword || '전체'})`);

        const articles = await scrapeSources(keyword || null);

        return Response.json({
            success: true,
            step: 'collect',
            count: articles.length,
            articles,
        });
    } catch (error) {
        console.error('[API/collect] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

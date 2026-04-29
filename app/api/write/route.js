// app/api/write/route.js
// STEP 2: Claude 글쓰기
import { step2_write } from '../../../lib/pipeline.js';

export const maxDuration = 60;

export async function POST(request) {
    try {
        const { geminiOutput } = await request.json();
        console.log('[API/write] Claude 글쓰기 시작...');

        const finalData = await step2_write(geminiOutput);

        return Response.json({
            success: true,
            step: 'write',
            data: finalData,
        });
    } catch (error) {
        console.error('[API/write] 오류:', error.message);
        return Response.json({ success: false, error: error.message }, { status: 500 });
    }
}

// app/api/write/route.js
// STEP 2: Claude 글쓰기
import { step2_write } from '../../../lib/pipeline.js';
import { badRequest, isPlainObject, readJsonBody } from '../../../lib/api.js';

// Vercel 서버리스 함수 타임아웃: 재시도(최대 3회 × 대기시간) 고려하여 120초로 설정
export const maxDuration = 120;

export async function POST(request) {
    try {
        const body = await readJsonBody(request);
        if (!body) return badRequest('Invalid JSON body');

        const { geminiOutput } = body;
        if (!isPlainObject(geminiOutput)) {
            console.error('[API/write] geminiOutput is not plain object:', JSON.stringify(geminiOutput));
            return badRequest('geminiOutput must be an object');
        }
        if (geminiOutput.error) return badRequest('geminiOutput contains an error', geminiOutput);

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

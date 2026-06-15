import { Client } from '@notionhq/client';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    process.env[trimmed.substring(0, eqIndex).trim()] = trimmed.substring(eqIndex + 1).trim();
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const dbId = process.env.NOTION_DATABASE_ID;

async function checkLatestPage() {
    try {
        console.log("Databases keys:", Object.keys(notion.databases));
        
        const response = await notion.search({
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 1
        });
        
        if (response.results.length === 0) {
            console.log('페이지가 없습니다.');
            return;
        }

        const latestPage = response.results[0];
        console.log('=== 최근 페이지 정보 ===');
        console.log('URL:', latestPage.url);
        
        const titleProp = latestPage.properties['기사 제목'] || latestPage.properties['이름'];
        const title = titleProp?.title?.[0]?.plain_text || '(제목 없음)';
        console.log('제목:', title);

        const cardNewsProp = latestPage.properties['카드뉴스 대본'];
        if (cardNewsProp) {
            console.log('카드뉴스 대본 속성 존재 여부: ✅ 존재함');
            const content = cardNewsProp.rich_text?.[0]?.plain_text || '';
            console.log('카드뉴스 대본 텍스트 길이:', content.length);
            if (content.length > 0) {
                console.log('미리보기:\n', content.substring(0, 200) + '...');
            } else {
                console.log('텍스트가 비어있습니다.');
            }
        } else {
            console.log('카드뉴스 대본 속성 존재 여부: ❌ 없음');
        }

        console.log('\n=== 본문(Children) 확인 ===');
        const blocks = await notion.blocks.children.list({ block_id: latestPage.id });
        const hasCardNewsHeader = blocks.results.some(b => 
            b.type === 'heading_2' && 
            b.heading_2.rich_text?.[0]?.plain_text?.includes('카드뉴스')
        );
        console.log('본문에 카드뉴스 헤딩 존재 여부:', hasCardNewsHeader ? '✅ 존재함' : '❌ 없음');

    } catch (err) {
        console.error('에러:', err.message);
    }
}

checkLatestPage();

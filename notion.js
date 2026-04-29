const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Notion rich_text는 최대 2000자 → 긴 텍스트를 자동 분할
function splitIntoParagraphs(text, maxLen = 2000) {
    if (!text) return [];
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
        chunks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: text.substring(i, i + maxLen) } }] },
        });
    }
    return chunks;
}

async function saveToNotion(parsedData) {
    console.log('[DEBUG] 📝 Notion에 데이터를 저장합니다...');

    if (!parsedData || parsedData.error) {
        console.log('[DEBUG] ⚠️ AI 가공 데이터가 없거나 에러가 포함되어 저장을 건너뜁니다.');
        return null;
    }

    const { meta, article, taxonomy } = parsedData;

    try {
        // 1. 속성(Properties) 매핑
        const properties = {
            "기사 제목": {
                title: [{ text: { content: article.title || '제목 없음' } }],
            },
            "테마 카테고리": {
                select: { name: meta.theme_label || '미분류' },
            },
            "해시태그": {
                multi_select: (taxonomy.hashtags || []).map(tag => ({ name: tag })),
            },
            "참고 출처": {
                multi_select: (meta.sources_used || []).map(source => ({ name: source })),
            },
        };

        // 2. 본문(Blocks) 구성 — 사용자 요청 레이아웃 순서
        const children = [];

        // (1) callout 블록 → 인트로 (☕ 이모지)
        children.push({
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [{ text: { content: article.intro || '' } }],
                icon: { type: 'emoji', emoji: '☕' },
            },
        });

        // (2) heading_2 → "📌 원포인트 딥다이브"
        children.push({
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ text: { content: '📌 원포인트 딥다이브' } }] },
        });

        // (3) paragraph → 딥다이브 본문
        children.push(...splitIntoParagraphs(article.deepdive));

        // (4) heading_2 → "🔍 전문가의 시선"
        children.push({
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ text: { content: '🔍 전문가의 시선' } }] },
        });

        // (5) paragraph → expert_touch 본문
        children.push(...splitIntoParagraphs(article.expert_touch));

        // (6) heading_2 → "👉 카페에서 이렇게 써먹어라"
        children.push({
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ text: { content: '👉 카페에서 이렇게 써먹어라' } }] },
        });

        // (7) bulleted_list → action_tips
        for (const tip of (article.action_tips || [])) {
            children.push({
                object: 'block',
                type: 'bulleted_list_item',
                bulleted_list_item: {
                    rich_text: [{ text: { content: tip.replace(/^👉\s*/, '') } }],
                },
            });
        }

        // (8) quote 블록 → 에디터 코멘트
        children.push({
            object: 'block',
            type: 'quote',
            quote: { rich_text: [{ text: { content: article.editor_comment || '' } }] },
        });

        // (9) paragraph → 해시태그 (갈색 텍스트)
        if (taxonomy.hashtags && taxonomy.hashtags.length > 0) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{
                        text: { content: taxonomy.hashtags.join('  ') },
                        annotations: { color: 'brown' },
                    }],
                },
            });
        }

        // (10) divider
        children.push({ object: 'block', type: 'divider', divider: {} });

        // (11) toggle 블록 → "📰 참고 기사 목록"
        if (meta.sources_used && meta.sources_used.length > 0) {
            children.push({
                object: 'block',
                type: 'toggle',
                toggle: {
                    rich_text: [{ text: { content: '📰 참고 기사 목록' } }],
                    children: meta.sources_used.map(source => ({
                        object: 'block',
                        type: 'bulleted_list_item',
                        bulleted_list_item: {
                            rich_text: [{ text: { content: source } }],
                        },
                    })),
                },
            });
        }

        // (추가) SNS 카드뉴스 대본
        if (parsedData.sns_content && parsedData.sns_content.card_news) {
            children.push(
                { object: 'block', type: 'divider', divider: {} },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: { rich_text: [{ text: { content: '📱 인스타그램 카드뉴스 대본' } }] },
                },
                ...parsedData.sns_content.card_news.map(slide => ({
                    object: 'block',
                    type: 'numbered_list_item',
                    numbered_list_item: { rich_text: [{ text: { content: slide } }] },
                }))
            );
        }

        // 3. Notion API 호출
        const response = await notion.pages.create({
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties,
            children,
        });

        console.log(`[DEBUG] ✅ Notion 저장 완료. 페이지 URL: ${response.url}`);
        return response.url;
    } catch (error) {
        console.error('[ERROR] ❌ Notion 저장 중 오류 발생:', error.message);
        throw error;
    }
}

module.exports = { saveToNotion };

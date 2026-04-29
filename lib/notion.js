// lib/notion.js
import { Client } from '@notionhq/client';

function splitIntoParagraphs(text, maxLen = 2000) {
    if (!text) return [];
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
        chunks.push({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: text.substring(i, i + maxLen) } }] },
        });
    }
    return chunks;
}

export async function saveToNotion(parsedData) {
    const notion = new Client({ auth: process.env.NOTION_API_KEY });

    if (!parsedData || parsedData.error) return null;
    const { meta, article, taxonomy } = parsedData;

    const properties = {
        "기사 제목": { title: [{ text: { content: article.title || '제목 없음' } }] },
        "테마 카테고리": { select: { name: meta.theme_label || '미분류' } },
        "해시태그": { multi_select: (taxonomy.hashtags || []).map(tag => ({ name: tag })) },
        "참고 출처": { multi_select: (meta.sources_used || []).map(s => ({ name: s })) },
    };

    const children = [];

    children.push({
        object: 'block', type: 'callout',
        callout: {
            rich_text: [{ text: { content: article.intro || '' } }],
            icon: { type: 'emoji', emoji: '☕' },
        },
    });

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '📌 원포인트 딥다이브' } }] } });
    children.push(...splitIntoParagraphs(article.deepdive));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '🔍 전문가의 시선' } }] } });
    children.push(...splitIntoParagraphs(article.expert_touch));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '👉 카페에서 이렇게 써먹어라' } }] } });
    for (const tip of (article.action_tips || [])) {
        children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: tip.replace(/^👉\s*/, '') } }] } });
    }

    children.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: article.editor_comment || '' } }] } });

    if (taxonomy.hashtags?.length > 0) {
        children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: taxonomy.hashtags.join('  ') }, annotations: { color: 'brown' } }] } });
    }

    children.push({ object: 'block', type: 'divider', divider: {} });

    if (meta.sources_used?.length > 0) {
        children.push({
            object: 'block', type: 'toggle',
            toggle: {
                rich_text: [{ text: { content: '📰 참고 기사 목록' } }],
                children: meta.sources_used.map(s => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: s } }] } })),
            },
        });
    }

    if (parsedData.sns_content?.card_news) {
        children.push(
            { object: 'block', type: 'divider', divider: {} },
            { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '📱 인스타그램 카드뉴스 대본' } }] } },
            ...parsedData.sns_content.card_news.map(s => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: [{ text: { content: s } }] } }))
        );
    }

    const response = await notion.pages.create({ parent: { database_id: process.env.NOTION_DATABASE_ID }, properties, children });
    return response.url;
}

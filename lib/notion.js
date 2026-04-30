// lib/notion.js
import { Client } from '@notionhq/client';
import { requireEnv } from './env.js';

function sanitizeSelectName(value, fallback = 'Unknown') {
    const text = String(value || fallback).trim() || fallback;
    return text.length > 100 ? text.substring(0, 97) + '...' : text;
}

function normalizeSourceName(source) {
    if (typeof source === 'string') return sanitizeSelectName(source);
    return sanitizeSelectName(source?.source);
}

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
    if (!parsedData || parsedData.error) return null;

    const notion = new Client({ auth: requireEnv('NOTION_API_KEY') });
    const databaseId = requireEnv('NOTION_DATABASE_ID');
    const meta = parsedData.meta || {};
    const article = parsedData.article || {};
    const taxonomy = parsedData.taxonomy || {};
    const hashtags = Array.isArray(taxonomy.hashtags) ? taxonomy.hashtags : [];
    const sourcesUsed = Array.isArray(meta.sources_used) ? meta.sources_used : [];

    const properties = {
        "기사 제목": { title: [{ text: { content: article.title || '제목 없음' } }] },
        "테마 카테고리": { select: { name: sanitizeSelectName(meta.theme_label, '미분류') } },
        "해시태그": { multi_select: hashtags.map(tag => ({ name: sanitizeSelectName(tag, '#미분류') })) },
        "참고 출처": { multi_select: sourcesUsed.map(s => ({ name: normalizeSourceName(s) })) },
    };

    const children = [];

    children.push({
        object: 'block', type: 'callout',
        callout: {
            rich_text: [{ text: { content: article.intro || '' } }],
            icon: { type: 'emoji', emoji: '☕' },
        },
    });

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '📌 트렌드 브리핑' } }] } });
    children.push(...splitIntoParagraphs(article.deepdive));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '☕ 내 한 잔에 어떤 의미?' } }] } });
    children.push(...splitIntoParagraphs(article.lifestyle || article.expert_touch));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '💡 이렇게 즐겨보세요' } }] } });
    for (const tip of (article.action_tips || [])) {
        children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: tip.replace(/^👉\s*/, '') } }] } });
    }

    children.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: article.editor_comment || '' } }] } });

    if (hashtags.length > 0) {
        children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: hashtags.join('  ') }, annotations: { color: 'brown' } }] } });
    }

    children.push({ object: 'block', type: 'divider', divider: {} });

    if (sourcesUsed.length > 0) {
        children.push({
            object: 'block', type: 'toggle',
            toggle: {
                rich_text: [{ text: { content: '📰 참고 기사 목록' } }],
                children: sourcesUsed.map(s => {
                    if (typeof s === 'string') {
                        return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: s } }] } };
                    }
                    // 객체인 경우 (source, title, link)
                    const textContent = `[${s.source || '출처'}] ${s.title || '기사'}`;
                    const richTextObj = { text: { content: textContent } };
                    if (s.link) {
                        richTextObj.text.link = { url: s.link };
                    }
                    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [richTextObj] } };
                }),
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

    const response = await notion.pages.create({ parent: { database_id: databaseId }, properties, children });
    return response.url;
}

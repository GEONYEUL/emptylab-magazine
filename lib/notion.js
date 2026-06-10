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

// Claude가 본문에 넣는 \\n 리터럴을 실제 줄바꿈으로 변환
// 왜: Claude Tool Use 응답에서 문자열 내부 줄바꿈이 \\n 리터럴로 오는 경우가 있음
function unescapeNewlines(text) {
    if (!text) return '';
    return text.replace(/\\n/g, '\n');
}

function splitIntoParagraphs(text, maxLen = 2000) {
    if (!text) return [];
    // \\n 리터럴 → 실제 줄바꿈 변환 후 분할
    const unescaped = unescapeNewlines(text);
    const chunks = [];
    for (let i = 0; i < unescaped.length; i += maxLen) {
        chunks.push({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: unescaped.substring(i, i + maxLen) } }] },
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

    // 핵심 검증: article 본문이 없으면 빈 페이지 생성을 차단
    if (!article.title || !article.deepdive) {
        console.error('[Notion] ❌ article 필수 필드 누락 — 빈 페이지 생성을 차단합니다.');
        console.error('[Notion] parsedData 키:', Object.keys(parsedData));
        console.error('[Notion] article 키:', Object.keys(article));
        throw new Error('article 데이터(title, deepdive)가 비어있어 Notion에 저장할 수 없습니다.');
    }

    const properties = {
        "기사 제목": { title: [{ text: { content: article.title || '제목 없음' } }] },
        "테마 카테고리": { select: { name: sanitizeSelectName(meta.theme_label, '미분류') } },
        "해시태그": { multi_select: hashtags.map(tag => ({ name: sanitizeSelectName(tag, '#미분류') })) },
        "참고 출처": { multi_select: sourcesUsed.map(s => ({ name: normalizeSourceName(s) })) },
    };

    // 생성일 속성 추가 (형식 검증 후 삽입)
    const generatedDate = meta.generated_at || new Date().toISOString().split('T')[0];
    if (generatedDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        properties["생성일"] = { date: { start: generatedDate } };
    }

    // 카드뉴스 대본 속성 추가 (문자열인지 배열인지 확인)
    const cardNewsRaw = parsedData.sns_content?.card_news;
    const cardNewsArr = Array.isArray(cardNewsRaw) ? cardNewsRaw : (typeof cardNewsRaw === 'string' ? cardNewsRaw.split('\n') : []);
    const cardNewsText = cardNewsArr.join('\n\n').substring(0, 2000); // 노션 rich_text 글자 수 제한 고려
    if (cardNewsText) {
        properties["카드뉴스 대본"] = { rich_text: [{ text: { content: cardNewsText } }] };
    }

    const children = [];

    // JSON 형태의 문자열이 튀어나오는 것을 방지 (AI 환각 방어)
    const cleanJsonString = (text) => {
        if (typeof text !== 'string') return '';
        const t = text.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
            try {
                const parsed = JSON.parse(t);
                const values = Object.values(parsed).filter(v => typeof v === 'string');
                if (values.length > 0) return values.join('\n\n');
            } catch(e) {}
        }
        return text;
    };

    children.push({
        object: 'block', type: 'callout',
        callout: {
            rich_text: [{ text: { content: unescapeNewlines(cleanJsonString(article.intro) || '') } }],
            icon: { type: 'emoji', emoji: '☕' },
        },
    });

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '📌 트렌드 브리핑' } }] } });
    children.push(...splitIntoParagraphs(cleanJsonString(article.deepdive)));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '☕ 내 한 잔에 어떤 의미?' } }] } });
    children.push(...splitIntoParagraphs(cleanJsonString(article.lifestyle || article.expert_touch)));

    children.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '💡 이렇게 즐겨보세요' } }] } });
    
    // 문자열이 글자 단위로 쪼개지는 버그 수정
    const actionTipsRaw = article.action_tips || [];
    const actionTipsArr = Array.isArray(actionTipsRaw) ? actionTipsRaw : (typeof actionTipsRaw === 'string' ? actionTipsRaw.split('\n') : [String(actionTipsRaw)]);
    
    for (const tip of actionTipsArr) {
        if (typeof tip !== 'string' || tip.trim().length === 0) continue;
        children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: tip.replace(/^👉\s*/, '') } }] } });
    }

    children.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: unescapeNewlines(cleanJsonString(article.editor_comment) || '') } }] } });

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

    // 본문에도 카드뉴스 대본을 남기길 원한다면 유지 (옵션)
    if (cardNewsArr.length > 0) {
        children.push(
            { object: 'block', type: 'divider', divider: {} },
            { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '📱 인스타그램 카드뉴스 대본' } }] } },
            ...cardNewsArr.map(s => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: [{ text: { content: typeof s === 'string' ? s : JSON.stringify(s) } }] } }))
        );
    }

    const response = await notion.pages.create({ parent: { database_id: databaseId }, properties, children });
    return response.url;
}

// lib/scraper.js
// 뉴스 수집 모듈 — 병렬 수집으로 속도 최적화 (Vercel 10초 제한 대응)
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';

const parser = new Parser({
    customFields: { item: ['content:encoded'] },
    timeout: 6000, // 6초 타임아웃 (개별 소스당)
});

async function fetchWithRetry(fn, retries = 1) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
        }
    }
}

function isWithin48Hours(pubDate) {
    if (!pubDate) return false;
    const date = new Date(pubDate);
    if (isNaN(date.getTime())) return false;
    return (Date.now() - date.getTime()) / (1000 * 60 * 60) <= 48;
}

const FOODBANK_KEYWORDS = ['커피', '카페', '음료', '바리스타', '에스프레소', '로스터', 'RTD', 'F&B', '원두'];

function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// 개별 RSS 소스를 수집하는 함수
async function scrapeRssSource(source, keyword) {
    const articles = [];
    try {
        const feed = await fetchWithRetry(() => parser.parseURL(source.url));

        for (const item of feed.items) {
            const url = item.link;
            if (!url) continue;

            const title = (item.title || '').trim();
            const rawContent = item['content:encoded'] || item.contentSnippet || item.content || '';
            const content = stripHtml(rawContent);

            if (!isWithin48Hours(item.pubDate || item.isoDate)) continue;
            if (title.length < 10) continue;

            // 식품외식경제 키워드 필터
            if (source.name === '식품외식경제') {
                if (!FOODBANK_KEYWORDS.some(kw => title.includes(kw) || content.includes(kw))) continue;
            }

            // 주문형 모드 필터링 제거 (Gemini 프롬프트에서 연관성 기반으로 분석하도록 위임)
            // if (keyword) {
            //     const kw = keyword.toLowerCase();
            //     if (!`${title} ${content}`.toLowerCase().includes(kw)) continue;
            // }

            articles.push({
                title,
                link: url,
                pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                source: source.name,
                contentSnippet: content.substring(0, 500),
            });
        }
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${source.name} 스킵:`, error.message);
    }
    return articles;
}

// HTML 크롤링 소스를 수집하는 함수
async function scrapeHtmlSource(source, keyword) {
    const articles = [];
    try {
        const response = await fetchWithRetry(() =>
            axios.get(source.url, {
                timeout: 6000,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmptyLabBot/1.0)' },
            })
        );
        const $ = cheerio.load(response.data);

        $('a').each((_i, el) => {
            const title = $(el).text().trim();
            let href = $(el).attr('href');
            if (!href || !title || title.length < 10) return;
            if (href.startsWith('/')) href = `${source.url}${href}`;
            if (!href.includes('bwissue.com')) return;

            // 주문형 모드 필터링 제거 (Gemini에서 처리)
            // if (keyword && !title.toLowerCase().includes(keyword.toLowerCase())) return;

            articles.push({
                title,
                link: href,
                pubDate: new Date().toISOString(),
                source: source.name,
                contentSnippet: '',
            });
        });
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${source.name} 스킵:`, error.message);
    }
    return articles;
}

const SOURCES = [
    { name: 'Perfect Daily Grind', type: 'rss', url: 'https://perfectdailygrind.com/feed/' },
    { name: 'Daily Coffee News',   type: 'rss', url: 'https://dailycoffeenews.com/feed/' },
    { name: 'Sprudge',             type: 'rss', url: 'https://sprudge.com/feed' },
    { name: '식품외식경제',          type: 'rss', url: 'http://www.foodbank.co.kr/rss/all.xml' },
    { name: '블랙워터이슈',          type: 'html', url: 'https://bwissue.com' },
];

/**
 * 뉴스 수집 — 모든 소스를 병렬로 동시 수집 (속도 3~4배 향상)
 * @param {string|null} keyword - 주문형 필터 키워드
 */
export async function scrapeSources(keyword = null) {
    console.log(`[SCRAPER] 🕒 병렬 수집 시작${keyword ? ` (키워드: "${keyword}")` : ''}...`);

    // 모든 소스를 Promise.allSettled로 동시에 수집 (하나가 실패해도 나머지는 계속)
    const results = await Promise.allSettled(
        SOURCES.map(source => {
            if (source.type === 'rss') return scrapeRssSource(source, keyword);
            return scrapeHtmlSource(source, keyword);
        })
    );

    // 성공한 결과만 합치기
    const allArticles = [];
    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            console.log(`[SCRAPER] ✅ ${SOURCES[i].name}: ${result.value.length}건`);
            allArticles.push(...result.value);
        } else {
            console.error(`[SCRAPER] ❌ ${SOURCES[i].name}: ${result.reason?.message}`);
        }
    });

    // URL 기준 중복 제거
    const seen = new Set();
    const unique = allArticles.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
    });

    console.log(`[SCRAPER] 🎉 수집 완료. 고유 기사 ${unique.length}건`);
    return unique.slice(0, 30);
}

// lib/scraper.js
// 뉴스 수집 모듈 — Vercel 서버리스 환경용 (파일시스템 미사용)
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';

const parser = new Parser({
    customFields: { item: ['content:encoded'] },
    timeout: 8000,
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(fn, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await delay(1500);
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

const SOURCES = [
    { name: 'Perfect Daily Grind', type: 'rss', url: 'https://perfectdailygrind.com/feed/' },
    { name: 'Daily Coffee News',   type: 'rss', url: 'https://dailycoffeenews.com/feed/' },
    { name: 'Sprudge',             type: 'rss', url: 'https://sprudge.com/feed' },
    { name: '식품외식경제',          type: 'rss', url: 'http://www.foodbank.co.kr/rss/all.xml' },
    { name: '블랙워터이슈',          type: 'html', url: 'https://bwissue.com' },
];

/**
 * 뉴스 수집 함수
 * @param {string|null} keyword - 주문형 모드일 때 필터링할 키워드 (null이면 전체 수집)
 */
export async function scrapeSources(keyword = null) {
    console.log(`[SCRAPER] 🕒 뉴스 수집 시작${keyword ? ` (키워드: "${keyword}")` : ' (전체 모드)'}...`);
    const newArticles = [];

    for (const source of SOURCES) {
        try {
            if (source.type === 'rss') {
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

                    // 주문형 모드: 키워드 필터링
                    if (keyword) {
                        const kw = keyword.toLowerCase();
                        const searchText = `${title} ${content}`.toLowerCase();
                        if (!searchText.includes(kw)) continue;
                    }

                    newArticles.push({
                        title,
                        link: url,
                        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                        source: source.name,
                        contentSnippet: content.substring(0, 500),
                    });
                }
            } else if (source.type === 'html') {
                const response = await fetchWithRetry(() =>
                    axios.get(source.url, {
                        timeout: 8000,
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

                    // 주문형 모드: 키워드 필터링
                    if (keyword && !title.toLowerCase().includes(keyword.toLowerCase())) return;

                    newArticles.push({
                        title,
                        link: href,
                        pubDate: new Date().toISOString(),
                        source: source.name,
                        contentSnippet: '',
                    });
                });
            }

            console.log(`[SCRAPER] ✅ ${source.name} 완료 (누적: ${newArticles.length}건)`);
        } catch (error) {
            console.error(`[SCRAPER] ❌ ${source.name} 스킵:`, error.message);
        }

        await delay(1000);
    }

    // 중복 URL 제거
    const seen = new Set();
    const unique = newArticles.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
    });

    console.log(`[SCRAPER] 🎉 수집 완료. 총 ${unique.length}건`);
    return unique.slice(0, 30); // 토큰 절약을 위해 최대 30개만 반환
}

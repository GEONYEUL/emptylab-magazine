// lib/scraper.js
// 뉴스 수집 모듈 — 다수 국내 F&B 매체 추가 & HTML 크롤링 범용화
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';

const parser = new Parser({
    customFields: { item: ['content:encoded', 'description'] },
    timeout: 8000,
});

// 랜덤 지연 함수 (로봇 차단 방지)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(fn, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await delay(1000 * (i + 1)); // 재시도 전 대기
        }
    }
}

function isWithin1Week(pubDate) {
    if (!pubDate) return false;
    const date = new Date(pubDate);
    if (isNaN(date.getTime())) return false;
    // 7일(168시간) 이내인지 확인
    return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24) <= 7;
}

function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── 강력한 키워드 필터링 (비용/안정성 방어) ──
const CORE_KEYWORDS = [
    '커피', '카페', '원두', '바리스타', '프랜차이즈', '로스팅', '에스프레소', 
    '디카페인', '대체당', '음료', '신메뉴', '생두', '스페셜티', '브루잉', 
    '핸드드립', '로스터리', '가맹', '홈카페', '베리에이션', '밀크', '그라인더',
    'F&B', '외식', '창업', '트렌드', '티', '베이커리', '상권', '스타벅스', '메가커피', '컴포즈'
];

function passesKeywordFilter(title, content) {
    const text = `${title} ${content}`.toLowerCase();
    return CORE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// ── RSS 수집기 ──
async function scrapeRssSource(source) {
    const articles = [];
    try {
        const feed = await fetchWithRetry(() => parser.parseURL(source.url));

        for (const item of feed.items) {
            const url = item.link;
            if (!url) continue;

            const title = (item.title || '').trim();
            const rawContent = item['content:encoded'] || item.description || item.contentSnippet || item.content || '';
            const content = stripHtml(rawContent);

            if (!isWithin1Week(item.pubDate || item.isoDate)) continue;
            if (title.length < 5) continue;

            // 필터링 적용
            if (!passesKeywordFilter(title, content)) continue;

            articles.push({
                title,
                link: url,
                pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                source: source.name,
                contentSnippet: content.substring(0, 400),
            });
        }
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${source.name} RSS 스킵:`, error.message);
    }
    return articles;
}

// ── HTML 수집기 (범용) ──
async function scrapeHtmlSource(source) {
    const articles = [];
    try {
        const response = await fetchWithRetry(() =>
            axios.get(source.url, {
                timeout: 8000,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
                },
            })
        );
        
        const $ = cheerio.load(response.data);

        $('a').each((_i, el) => {
            const title = $(el).text().trim().replace(/\s+/g, ' ');
            let href = $(el).attr('href');
            
            if (!href || !title || title.length < 8) return;
            
            // 상대 경로를 절대 경로로 변환
            try {
                href = new URL(href, source.url).href;
            } catch (e) {
                return;
            }

            // 너무 짧은 링크(메뉴 등) 제외, javascript 링크 제외
            if (href.includes('javascript:') || href.includes('#')) return;

            // 필터링 적용 (HTML 크롤링은 본문을 가져오기 힘드므로 제목 위주로 필터링)
            if (!passesKeywordFilter(title, '')) return;

            articles.push({
                title,
                link: href,
                pubDate: new Date().toISOString(),
                source: source.name,
                contentSnippet: '', // HTML 스크래핑은 상세 본문 텍스트 생략
            });
        });
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${source.name} HTML 스킵:`, error.message);
    }
    return articles;
}

// ── 타겟 소스 목록 ──
const SOURCES = [
    // 기존 소스
    { name: 'Perfect Daily Grind', type: 'rss', url: 'https://perfectdailygrind.com/feed/' },
    { name: 'Daily Coffee News',   type: 'rss', url: 'https://dailycoffeenews.com/feed/' },
    { name: 'Sprudge',             type: 'rss', url: 'https://sprudge.com/feed' },
    { name: '식품외식경제',          type: 'rss', url: 'http://www.foodbank.co.kr/rss/all.xml' },
    { name: '블랙워터이슈',          type: 'html', url: 'https://bwissue.com' },
    // 신규 소스
    { name: '식품음료신문',          type: 'rss', url: 'http://www.thinkfood.co.kr/rss/all.xml' },
    { name: '식품저널',             type: 'rss', url: 'http://www.foodnews.co.kr/rss/all.xml' },
    { name: '월간 창업&프랜차이즈',   type: 'rss', url: 'http://www.fcmedia.co.kr/rss/all.xml' },
    { name: '월간커피',             type: 'html', url: 'https://www.themonthlycoffee.co.kr' },
    { name: '더컵(THE CUP)',       type: 'html', url: 'http://www.thecup.co.kr' },
    { name: '리테일매거진',          type: 'html', url: 'http://www.retailing.co.kr' },
    { name: 'SCA Korea',           type: 'html', url: 'https://scakorea.kr' },
];

/**
 * 뉴스 수집 — 각 요청 사이에 딜레이를 주며 수집 (크롤링 차단 방지)
 */
export async function scrapeSources(keyword = null) {
    console.log(`[SCRAPER] 🕒 수집 시작 (키워드: "${keyword || '전체'}", 총 ${SOURCES.length}개 소스)...`);

    // 모든 소스를 돌되, 요청 간에 시차(Stagger)를 두어 봇 차단을 우회함
    const results = await Promise.allSettled(
        SOURCES.map(async (source, index) => {
            // 사이트마다 최소 2초의 딜레이를 두어 트래픽 분산 (순차적이 아닌 시차 병렬 실행)
            await delay(index * 2000); 
            
            if (source.type === 'rss') return scrapeRssSource(source);
            return scrapeHtmlSource(source);
        })
    );

    const allArticles = [];
    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            console.log(`[SCRAPER] ✅ ${SOURCES[i].name}: ${result.value.length}건 수집`);
            allArticles.push(...result.value);
        } else {
            console.error(`[SCRAPER] ❌ ${SOURCES[i].name} 최종 실패:`, result.reason?.message);
        }
    });

    // 1차 중복 제거: 완전 동일한 링크 제거
    const seen = new Set();
    let unique = allArticles.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
    });

    // 2차 필터: 사용자가 웹앱에서 입력한 '주문형 키워드'가 있다면 (Gemini의 부담을 줄이기 위한 Soft Filter)
    if (keyword) {
        const kw = keyword.toLowerCase();
        // 주문형 키워드가 제목이나 요약본에 있는 것만 우선 선별
        const keywordMatched = unique.filter(a => 
            `${a.title} ${a.contentSnippet}`.toLowerCase().includes(kw)
        );
        // 너무 많이 줄어들면 원본 유지 (AI가 유추하도록)
        if (keywordMatched.length >= 2) {
            unique = keywordMatched;
        }
    }

    // 최신순으로 정렬 (rss의 경우 pubDate가 있음, html은 현재시간)
    unique.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // 상위 35개만 자르기 (프롬프트 토큰 최적화 및 속도 향상)
    const finalArticles = unique.slice(0, 35);
    
    console.log(`[SCRAPER] 🎉 수집 완료. 최종 전달 기사 ${finalArticles.length}건`);
    return finalArticles;
}

// lib/scraper.js
// 뉴스 수집 모듈 — 사이트별 맞춤 크롤링 + 날짜 필터링 강화
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';

const parser = new Parser({
    customFields: { item: ['content:encoded', 'description'] },
    timeout: 8000,
});

// ── 유틸리티 함수 ──
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 브라우저처럼 보이는 HTTP 헤더
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function fetchWithRetry(fn, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await delay(1000 * (i + 1));
        }
    }
}

// 안전한 HTTP GET 요청
async function safeGet(url, timeout = 8000) {
    return fetchWithRetry(() =>
        axios.get(url, { timeout, headers: BROWSER_HEADERS })
    );
}

// 날짜가 최근 7일 이내인지 확인
function isWithin1Week(pubDate) {
    if (!pubDate) return false;
    const date = new Date(pubDate);
    if (isNaN(date.getTime())) return false;
    return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24) <= 7;
}

// "N일 전", "N시간 전" 형태의 상대 날짜를 실제 Date로 변환
function parseRelativeDate(text) {
    if (!text) return null;
    const trimmed = text.trim();

    // "N일 전" 패턴
    const daysMatch = trimmed.match(/(\d+)\s*일\s*전/);
    if (daysMatch) {
        const d = new Date();
        d.setDate(d.getDate() - parseInt(daysMatch[1]));
        return d;
    }

    // "N시간 전" 패턴
    const hoursMatch = trimmed.match(/(\d+)\s*시간\s*전/);
    if (hoursMatch) {
        const d = new Date();
        d.setHours(d.getHours() - parseInt(hoursMatch[1]));
        return d;
    }

    // "N분 전" 패턴
    const minsMatch = trimmed.match(/(\d+)\s*분\s*전/);
    if (minsMatch) {
        return new Date(); // 방금 전이므로 현재 시각
    }

    // "YYYY-MM-DD" 또는 "YYYY.MM.DD" 패턴
    const absMatch = trimmed.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (absMatch) {
        return new Date(`${absMatch[1]}-${absMatch[2].padStart(2, '0')}-${absMatch[3].padStart(2, '0')}`);
    }

    // "MM.DD" 또는 "MM-DD" 패턴 (올해로 간주)
    const shortMatch = trimmed.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
    if (shortMatch) {
        const year = new Date().getFullYear();
        return new Date(`${year}-${shortMatch[1].padStart(2, '0')}-${shortMatch[2].padStart(2, '0')}`);
    }

    return null;
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
    'F&B', '외식', '창업', '트렌드', '티', '베이커리', '상권', '스타벅스', '메가커피', '컴포즈',
    'coffee', 'cafe', 'espresso', 'barista', 'roast', 'latte', 'brew'
];

function passesKeywordFilter(title, content) {
    const text = `${title} ${content}`.toLowerCase();
    return CORE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// ══════════════════════════════════════
// ── RSS 수집기 (날짜 필터링 O) ──
// ══════════════════════════════════════
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
            const pubDate = item.pubDate || item.isoDate;

            // ✅ 핵심: 7일 이내 기사만 통과
            if (!isWithin1Week(pubDate)) {
                continue;
            }
            if (title.length < 5) continue;
            if (!passesKeywordFilter(title, content)) continue;

            articles.push({
                title,
                link: url,
                pubDate: pubDate || new Date().toISOString(),
                source: source.name,
                contentSnippet: content.substring(0, 400),
            });
        }
        console.log(`[SCRAPER] 📰 ${source.name} RSS: 전체 ${feed.items?.length || 0}건 중 ${articles.length}건 통과 (7일 필터)`);
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${source.name} RSS 스킵:`, error.message);
    }
    return articles;
}

// ══════════════════════════════════════
// ── 블랙워터이슈 전용 크롤러 ──
// 목록 페이지에서 "N일 전" 형태의 날짜를 추출하여 필터링
// ══════════════════════════════════════
async function scrapeBwissue() {
    const articles = [];
    const sourceName = '블랙워터이슈';
    try {
        const response = await safeGet('https://bwissue.com/news');
        const $ = cheerio.load(response.data);

        // 기사 목록의 각 항목을 순회
        // bwissue.com/news 페이지는 게시판 형태로 기사가 나열됨
        $('a').each((_i, el) => {
            const $el = $(el);
            const title = $el.text().trim().replace(/\s+/g, ' ');
            let href = $el.attr('href');

            if (!href || !title || title.length < 8) return;

            // bwissue.com 내부 링크만 수집
            try {
                href = new URL(href, 'https://bwissue.com').href;
            } catch (e) { return; }
            if (!href.includes('bwissue.com')) return;
            if (href.includes('javascript:') || href === 'https://bwissue.com/') return;

            // 기사 상세 페이지 링크 패턴만 수집 (게시글 URL 패턴)
            if (!href.match(/bwissue\.com\/.+\//)) return;

            // 부모/형제 요소에서 날짜 정보 찾기
            const $parent = $el.closest('tr, li, div, article');
            const parentText = $parent.text();

            // "N일 전", "N시간 전", "YYYY-MM-DD" 등 날짜 패턴 탐색
            const datePatterns = parentText.match(/(\d+\s*일\s*전|\d+\s*시간\s*전|\d+\s*분\s*전|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
            let parsedDate = null;

            if (datePatterns) {
                parsedDate = parseRelativeDate(datePatterns[1]);
            }

            // ✅ 날짜를 파싱할 수 있고, 7일 이내가 아니면 스킵
            if (parsedDate && !isWithin1Week(parsedDate)) return;

            // 날짜를 전혀 파싱하지 못한 경우에도 스킵 (오래된 기사일 수 있음)
            if (!parsedDate) return;

            if (!passesKeywordFilter(title, '')) return;

            articles.push({
                title,
                link: href,
                pubDate: parsedDate ? parsedDate.toISOString() : new Date().toISOString(),
                source: sourceName,
                contentSnippet: '',
            });
        });

        console.log(`[SCRAPER] 📰 ${sourceName}: ${articles.length}건 통과 (7일 필터)`);
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${sourceName} 스킵:`, error.message);
    }
    return articles;
}

// ══════════════════════════════════════
// ── 월간 커피앤티 전용 크롤러 ──
// 목록에 날짜가 없으므로, 상세 페이지에서 날짜를 확인하는 2단계 수집
// ══════════════════════════════════════
async function scrapeCoffeeAndTea() {
    const articles = [];
    const sourceName = '월간 커피앤티';
    try {
        const response = await safeGet('https://coffeeandtea-magazine.com');
        const $ = cheerio.load(response.data);

        // 1단계: 메인 페이지에서 기사 링크 후보 수집
        const candidates = [];
        $('a').each((_i, el) => {
            const $el = $(el);
            const title = $el.text().trim().replace(/\s+/g, ' ');
            let href = $el.attr('href');

            if (!href || !title || title.length < 8) return;

            try {
                href = new URL(href, 'https://coffeeandtea-magazine.com').href;
            } catch (e) { return; }

            if (!href.includes('coffeeandtea-magazine.com')) return;
            if (href.includes('javascript:') || href.includes('#')) return;
            // 기사 상세 페이지 패턴 (워드프레스 기반: ?p=, /archives/, 슬러그 등)
            if (!href.match(/(\?p=|\d{4}\/|archives|\/\d+\/)/)) return;

            if (!passesKeywordFilter(title, '')) return;

            candidates.push({ title, link: href });
        });

        console.log(`[SCRAPER] 🔍 ${sourceName}: 후보 기사 ${candidates.length}건, 날짜 확인 중...`);

        // 2단계: 상위 10개 후보의 상세 페이지에서 날짜 확인 (속도 제한)
        const toCheck = candidates.slice(0, 10);
        for (const candidate of toCheck) {
            try {
                await delay(300); // 요청 간 딜레이
                const detailRes = await axios.get(candidate.link, {
                    timeout: 5000,
                    headers: BROWSER_HEADERS,
                });
                const detail$ = cheerio.load(detailRes.data);

                // 페이지에서 날짜 추출 시도
                // 워드프레스 표준: <time> 태그, .entry-date, .post-date, meta[property="article:published_time"]
                let dateStr = null;

                // 방법 1: <time> 태그의 datetime 속성
                const timeEl = detail$('time[datetime]').first();
                if (timeEl.length) dateStr = timeEl.attr('datetime');

                // 방법 2: meta 태그
                if (!dateStr) {
                    const metaDate = detail$('meta[property="article:published_time"]').attr('content')
                        || detail$('meta[name="date"]').attr('content');
                    if (metaDate) dateStr = metaDate;
                }

                // 방법 3: 본문 내 "YYYY-MM-DD" 또는 "YYYY.MM.DD" 패턴 탐색
                if (!dateStr) {
                    const bodyText = detail$('body').text();
                    const dateMatch = bodyText.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
                    if (dateMatch) {
                        dateStr = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
                    }
                }

                if (!dateStr) continue; // 날짜를 못 찾으면 스킵

                const parsedDate = new Date(dateStr);
                if (isNaN(parsedDate.getTime())) continue;

                // ✅ 핵심: 7일 이내 기사만 통과
                if (!isWithin1Week(parsedDate)) {
                    continue;
                }

                articles.push({
                    title: candidate.title,
                    link: candidate.link,
                    pubDate: parsedDate.toISOString(),
                    source: sourceName,
                    contentSnippet: '',
                });
            } catch (err) {
                // 상세 페이지 접근 실패 시 해당 기사만 스킵
                continue;
            }
        }

        console.log(`[SCRAPER] 📰 ${sourceName}: ${articles.length}건 통과 (7일 필터)`);
    } catch (error) {
        console.error(`[SCRAPER] ❌ ${sourceName} 스킵:`, error.message);
    }
    return articles;
}

// ── 타겟 소스 목록 ──
// 국내 소스 (우선순위 높음)
const DOMESTIC_RSS_SOURCES = [
    { name: '식품외식경제',          url: 'http://www.foodbank.co.kr/rss/all.xml' },
    { name: '식품음료신문',          url: 'http://www.thinkfood.co.kr/rss/all.xml' },
    { name: '식품저널',             url: 'http://www.foodnews.co.kr/rss/all.xml' },
    { name: '월간 창업&프랜차이즈',   url: 'http://www.fcmedia.co.kr/rss/all.xml' },
];

// 해외 소스 (보충 자료)
const GLOBAL_RSS_SOURCES = [
    { name: 'Perfect Daily Grind', url: 'https://perfectdailygrind.com/feed/' },
    { name: 'Daily Coffee News',   url: 'https://dailycoffeenews.com/feed/' },
    { name: 'Sprudge',             url: 'https://sprudge.com/feed' },
];

const ALL_RSS_SOURCES = [...DOMESTIC_RSS_SOURCES, ...GLOBAL_RSS_SOURCES];

// 국내 매체명 목록 (정렬 시 우선순위 판별용)
const DOMESTIC_SOURCE_NAMES = new Set([
    ...DOMESTIC_RSS_SOURCES.map(s => s.name),
    '블랙워터이슈', '월간 커피앤티',
]);

// HTML 전용 크롤러 (사이트별 맞춤 함수)
const HTML_SCRAPERS = [
    { name: '블랙워터이슈', fn: scrapeBwissue },
    { name: '월간 커피앤티', fn: scrapeCoffeeAndTea },
];

/**
 * 뉴스 수집 — 모든 소스에서 최근 7일 이내 기사만 수집, 국내 기사 우선
 */
export async function scrapeSources(keyword = null) {
    const totalSources = ALL_RSS_SOURCES.length + HTML_SCRAPERS.length;
    console.log(`[SCRAPER] 🕒 수집 시작 (키워드: "${keyword || '전체'}", 총 ${totalSources}개 소스)...`);

    // 모든 소스를 병렬 수집 (시차 적용)
    const allTasks = [
        // RSS 소스들 (국내 먼저, 해외 이후)
        ...ALL_RSS_SOURCES.map((source, i) =>
            delay(i * 300).then(() => scrapeRssSource(source))
        ),
        // HTML 전용 크롤러들
        ...HTML_SCRAPERS.map((scraper, i) =>
            delay((ALL_RSS_SOURCES.length + i) * 500).then(() => scraper.fn())
        ),
    ];

    const results = await Promise.allSettled(allTasks);

    const allArticles = [];
    const sourceNames = [
        ...ALL_RSS_SOURCES.map(s => s.name),
        ...HTML_SCRAPERS.map(s => s.name),
    ];

    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            allArticles.push(...result.value);
        } else {
            console.error(`[SCRAPER] ❌ ${sourceNames[i]} 최종 실패:`, result.reason?.message);
        }
    });

    // 1차 중복 제거
    const seen = new Set();
    let unique = allArticles.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
    });

    // 2차 필터: 사용자가 웹앱에서 입력한 '주문형 키워드' Soft Filter
    if (keyword) {
        const kw = keyword.toLowerCase();
        const keywordMatched = unique.filter(a =>
            `${a.title} ${a.contentSnippet}`.toLowerCase().includes(kw)
        );
        if (keywordMatched.length >= 2) {
            unique = keywordMatched;
        }
    }

    // ✅ 핵심: 국내 기사 우선 정렬 → 같은 그룹 내에서 최신순
    unique.sort((a, b) => {
        const aIsDomestic = DOMESTIC_SOURCE_NAMES.has(a.source) ? 0 : 1;
        const bIsDomestic = DOMESTIC_SOURCE_NAMES.has(b.source) ? 0 : 1;
        // 먼저 국내/해외 구분, 같은 구분 내에서 최신순
        if (aIsDomestic !== bIsDomestic) return aIsDomestic - bIsDomestic;
        return new Date(b.pubDate) - new Date(a.pubDate);
    });

    // 상위 35개만 전달 (국내 기사가 상단에 위치하므로 Gemini가 국내를 먼저 분석)
    const finalArticles = unique.slice(0, 35);

    // 국내/해외 비율 로그
    const domesticCount = finalArticles.filter(a => DOMESTIC_SOURCE_NAMES.has(a.source)).length;
    const globalCount = finalArticles.length - domesticCount;
    console.log(`[SCRAPER] 🎉 수집 완료. 최종 ${finalArticles.length}건 (국내 ${domesticCount}건 🇰🇷 / 해외 ${globalCount}건 🌍)`);

    if (finalArticles.length > 0) {
        const oldest = finalArticles[finalArticles.length - 1];
        const newest = finalArticles[0];
        console.log(`[SCRAPER] 📅 기간: ${newest.pubDate?.substring(0, 10)} ~ ${oldest.pubDate?.substring(0, 10)}`);
    }

    return finalArticles;
}

const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

const parser = new Parser({
    // 일부 RSS 소스에서 커스텀 필드를 사용하므로 허용 범위를 넓혀둠
    customFields: { item: ['content:encoded'] },
    // 타임아웃 10초 (응답이 너무 오래 걸리면 에러 처리)
    timeout: 10000,
});

// 중복 방지를 위해 처리된 URL을 저장할 로컬 파일
const SEEN_ARTICLES_FILE = path.join(__dirname, 'seen_articles.json');

// ──────────────────────────────────────────────────
// 유틸리티 함수
// ──────────────────────────────────────────────────

// 딜레이 (크롤링 차단 방지)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 재시도 로직 (최대 3회, 매 실패 시 2초 대기)
async function fetchWithRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`[DEBUG] ⚠️ 요청 실패 (${error.message}). 2초 대기 후 ${i + 2}번째 재시도...`);
            await delay(2000);
        }
    }
}

// 48시간 이내 게시 여부 판별
function isWithin48Hours(pubDate) {
    if (!pubDate) return false;
    const date = new Date(pubDate);
    // 유효하지 않은 날짜 문자열이 들어왔을 때 방어
    if (isNaN(date.getTime())) return false;
    const now = new Date();
    const diffHours = (now - date) / (1000 * 60 * 60);
    return diffHours <= 48;
}

// 식품외식경제 전용 키워드 필터
const FOODBANK_KEYWORDS = ['커피', '카페', '음료', '바리스타', '에스프레소', '로스터', 'RTD', 'F&B', '원두'];
function hasFoodbankKeyword(text) {
    if (!text) return false;
    return FOODBANK_KEYWORDS.some(kw => text.includes(kw));
}

// HTML 태그를 제거하여 순수 텍스트만 추출
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────
// 중복 방지 DB (JSON 기반 로컬 파일)
// ──────────────────────────────────────────────────

async function loadSeenArticles() {
    try {
        const data = await fs.readFile(SEEN_ARTICLES_FILE, 'utf8');
        return new Set(JSON.parse(data)); // Set 자료구조로 변환하여 검색 속도 O(1)로 향상
    } catch {
        return new Set();
    }
}

async function saveSeenArticles(seenSet) {
    // Set → 배열 변환, 최신 1000개만 유지하여 파일 크기 관리
    const arr = [...seenSet].slice(-1000);
    await fs.writeFile(SEEN_ARTICLES_FILE, JSON.stringify(arr, null, 2));
}

// ──────────────────────────────────────────────────
// 메인 수집 함수
// ──────────────────────────────────────────────────

async function scrapeSources() {
    console.log('[DEBUG] 🕒 뉴스 수집 엔진을 가동합니다...');
    const seenUrls = await loadSeenArticles();
    const newArticles = [];

    // 수집 대상 소스 (우선순위 순)
    const sources = [
        { name: 'Perfect Daily Grind', type: 'rss', url: 'https://perfectdailygrind.com/feed/' },
        { name: 'Daily Coffee News',   type: 'rss', url: 'https://dailycoffeenews.com/feed/' },
        { name: 'Sprudge',             type: 'rss', url: 'https://sprudge.com/feed' },
        { name: '식품외식경제',          type: 'rss', url: 'http://www.foodbank.co.kr/rss/all.xml' },
        { name: '블랙워터이슈',          type: 'html', url: 'https://bwissue.com' },
    ];

    for (const source of sources) {
        console.log(`[DEBUG] 📡 수집 시작: ${source.name} (${source.type.toUpperCase()})`);

        try {
            if (source.type === 'rss') {
                const feed = await fetchWithRetry(() => parser.parseURL(source.url));

                for (const item of feed.items) {
                    const url = item.link;
                    if (!url) continue;

                    const title = (item.title || '').trim();
                    // content:encoded(전문) → contentSnippet(요약) → content(HTML) 순으로 우선순위를 둠
                    const rawContent = item['content:encoded'] || item.contentSnippet || item.content || '';
                    const content = stripHtml(rawContent);

                    // 필터 1: 중복 URL 체크 (Set.has()로 O(1) 검색)
                    if (seenUrls.has(url)) continue;

                    // 필터 2: 48시간 이내 게시글만
                    if (!isWithin48Hours(item.pubDate || item.isoDate)) continue;

                    // 필터 3: 제목 10자 이상 (단신 제외)
                    if (title.length < 10) continue;

                    // 필터 4: 식품외식경제 키워드 필터링
                    if (source.name === '식품외식경제') {
                        if (!hasFoodbankKeyword(title) && !hasFoodbankKeyword(content)) {
                            continue;
                        }
                    }

                    newArticles.push({
                        title,
                        link: url,
                        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                        source: source.name,
                        contentSnippet: content.substring(0, 500),
                    });
                    seenUrls.add(url);
                }
            } else if (source.type === 'html') {
                // 블랙워터이슈 HTML 크롤링
                const response = await fetchWithRetry(() =>
                    axios.get(source.url, {
                        timeout: 10000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmptyLabBot/1.0)' },
                    })
                );
                const $ = cheerio.load(response.data);

                // 기사 링크를 담고 있을만한 a 태그를 순회
                // 같은 사이트(bwissue.com) 내부 링크이면서 제목이 충분히 긴 것만 추출
                $('a').each((_i, element) => {
                    const el = $(element);
                    const title = el.text().trim();
                    let href = el.attr('href');

                    if (!href || !title || title.length < 10) return;

                    // 상대 경로 → 절대 경로 변환
                    if (href.startsWith('/')) {
                        href = `${source.url}${href}`;
                    }

                    // 외부 링크(광고 등)를 제외하고 bwissue.com 내부 링크만 수집
                    if (!href.includes('bwissue.com')) return;
                    if (seenUrls.has(href)) return;

                    newArticles.push({
                        title,
                        link: href,
                        pubDate: new Date().toISOString(),
                        source: source.name,
                        contentSnippet: '',
                    });
                    seenUrls.add(href);
                });
            }

            console.log(`[DEBUG] ✅ ${source.name} 수집 완료 (누적 신규 기사: ${newArticles.length}건)`);
        } catch (error) {
            // 장애 내성: 하나의 소스가 실패해도 나머지 소스 수집은 계속 진행
            console.error(`[ERROR] ❌ ${source.name} 수집 중 치명적 오류. 해당 소스 스킵:`, error.message);
        }

        // 요청 간 2초 딜레이 (크롤링 차단 방지)
        await delay(2000);
    }

    // 수집된 URL 목록을 로컬 DB에 갱신
    await saveSeenArticles(seenUrls);

    console.log(`[DEBUG] 🎉 뉴스 수집 최종 완료. 총 ${newArticles.length}개의 새로운 기사를 확보했습니다.`);
    return newArticles;
}

module.exports = { scrapeSources };

'use client';
import { useState } from 'react';

// 파이프라인 4단계 정의
const STEPS = [
    { id: 'collect', label: '뉴스 수집', icon: '📡', desc: 'RSS 소스에서 기사를 수집합니다' },
    { id: 'preprocess', label: 'Gemini 전처리', icon: '🤖', desc: 'AI가 핵심 팩트를 추출합니다' },
    { id: 'write', label: 'Claude 글쓰기', icon: '✍️', desc: '수석 에디터가 칼럼을 작성합니다' },
    { id: 'save', label: '발행', icon: '🚀', desc: 'Notion 저장 + Slack 알림' },
];

// API 응답을 안전하게 파싱하는 헬퍼
// 서버가 JSON이 아닌 텍스트(에러 페이지 등)를 반환해도 크래시 방지
async function safeFetch(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        // JSON 파싱 실패 → 서버가 에러 텍스트를 반환한 경우
        throw new Error(`서버 오류 (${res.status}): ${text.substring(0, 200)}`);
    }
}

export default function Home() {
    const [keyword, setKeyword] = useState('');
    const [currentStep, setCurrentStep] = useState(-1);
    const [stepResults, setStepResults] = useState({});
    const [finalResult, setFinalResult] = useState(null);
    const [error, setError] = useState(null);
    const [isRunning, setIsRunning] = useState(false);

    async function runPipeline() {
        setIsRunning(true);
        setError(null);
        setFinalResult(null);
        setStepResults({});

        try {
            // STEP 0: 뉴스 수집
            setCurrentStep(0);
            const collectData = await safeFetch('/api/collect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword: keyword.trim() || null }),
            });
            if (!collectData.success) throw new Error(collectData.error || '수집 실패');
            setStepResults(prev => ({ ...prev, collect: collectData }));

            // STEP 1: Gemini 전처리
            setCurrentStep(1);
            const preprocessData = await safeFetch('/api/preprocess', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articles: collectData.articles }),
            });
            if (!preprocessData.success) {
                if (preprocessData.data?.error === 'INSUFFICIENT_DATA') {
                    throw new Error(`기사 부족 (${preprocessData.data.count}건) — 다른 키워드로 시도해 보세요`);
                }
                throw new Error(preprocessData.error || '전처리 실패');
            }
            setStepResults(prev => ({ ...prev, preprocess: preprocessData }));

            // STEP 2: Claude 글쓰기
            setCurrentStep(2);
            const writeData = await safeFetch('/api/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiOutput: preprocessData.data }),
            });
            if (!writeData.success) throw new Error(writeData.error || '글쓰기 실패');
            setStepResults(prev => ({ ...prev, write: writeData }));

            // STEP 3: 저장 & 알림
            setCurrentStep(3);
            const saveData = await safeFetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ finalData: writeData.data }),
            });
            setStepResults(prev => ({ ...prev, save: saveData }));

            // 완료
            setCurrentStep(4);
            setFinalResult({
                article: writeData.data,
                notionUrl: saveData.notionUrl,
            });
        } catch (err) {
            setError(err.message);
            setCurrentStep(-1);
        } finally {
            setIsRunning(false);
        }
    }

    return (
        <main className="min-h-screen px-4 py-8 md:py-16 max-w-4xl mx-auto">
            {/* 헤더 */}
            <header className="text-center mb-12">
                <div className="inline-block mb-4 px-4 py-1.5 rounded-full border border-white/10 text-sm" style={{ color: 'var(--color-text-dim)' }}>
                    Gemini × Claude 체이닝 아키텍처
                </div>
                <h1 className="text-4xl md:text-5xl font-bold mb-3 tracking-tight">
                    <span style={{ color: 'var(--color-gold)' }}>Empty Lab</span> Magazine
                </h1>
                <p style={{ color: 'var(--color-text-dim)' }} className="text-lg">
                    AI가 만드는 커피 산업 매거진 뉴스룸
                </p>
            </header>

            {/* 입력 영역 */}
            <div className="glass-card p-6 md:p-8 mb-8">
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-dim)' }}>
                    주제를 입력하세요 (비워두면 오늘의 전체 트렌드를 분석합니다)
                </label>
                <div className="flex gap-3">
                    <input
                        id="keyword-input"
                        type="text"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && !isRunning && runPipeline()}
                        placeholder="예: 디카페인, 콜드브루, 오트밀크..."
                        disabled={isRunning}
                        className="flex-1 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] transition-all disabled:opacity-50"
                    />
                    <button
                        id="generate-btn"
                        onClick={runPipeline}
                        disabled={isRunning}
                        className="px-6 py-3 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        style={{
                            background: isRunning ? 'var(--color-text-dim)' : 'linear-gradient(135deg, var(--color-accent), var(--color-accent-light))',
                            color: 'white',
                        }}
                    >
                        {isRunning ? '생성 중...' : '☕ 매거진 생성'}
                    </button>
                </div>
            </div>

            {/* 파이프라인 진행 상황 */}
            {currentStep >= 0 && (
                <div className="glass-card p-6 mb-8 animate-fade-in">
                    <h3 className="text-sm font-medium mb-4" style={{ color: 'var(--color-text-dim)' }}>
                        파이프라인 진행 상황
                    </h3>
                    <div className="flex items-center justify-between">
                        {STEPS.map((step, i) => (
                            <div key={step.id} className="flex items-center flex-1">
                                <div className="flex flex-col items-center gap-2 flex-1">
                                    <div className={`step-dot ${i < currentStep ? 'done' : i === currentStep ? 'active' : 'waiting'}`} />
                                    <span className="text-xs text-center" style={{ color: i <= currentStep ? 'var(--color-text)' : 'var(--color-text-dim)' }}>
                                        {step.icon} {step.label}
                                    </span>
                                    {i === currentStep && isRunning && (
                                        <span className="text-xs" style={{ color: 'var(--color-accent-light)' }}>
                                            {step.desc}...
                                        </span>
                                    )}
                                    {/* 각 스텝의 결과 요약 */}
                                    {stepResults[step.id] && i < currentStep && (
                                        <span className="text-xs" style={{ color: '#4ade80' }}>
                                            {step.id === 'collect' && `${stepResults.collect.count}건 수집`}
                                            {step.id === 'preprocess' && `${stepResults.preprocess.data?.theme_label}`}
                                            {step.id === 'write' && '✓ 완료'}
                                            {step.id === 'save' && '✓ 발행'}
                                        </span>
                                    )}
                                </div>
                                {i < STEPS.length - 1 && (
                                    <div className="h-px flex-1 mx-2" style={{ background: i < currentStep ? '#4ade80' : 'var(--color-text-dim)', opacity: 0.3 }} />
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 에러 */}
            {error && (
                <div className="glass-card p-6 mb-8 border-l-4 animate-fade-in" style={{ borderColor: 'var(--color-accent)' }}>
                    <p className="font-medium" style={{ color: 'var(--color-accent-light)' }}>⚠️ 오류 발생</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--color-text-dim)' }}>{error}</p>
                </div>
            )}

            {/* 결과 표시 */}
            {finalResult && (
                <div className="space-y-6 animate-fade-in">
                    {/* 제목 & 메타 */}
                    <div className="glass-card p-6 md:p-8">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <span className="inline-block px-3 py-1 rounded-full text-xs font-medium mb-3" style={{ background: 'var(--color-accent)', color: 'white' }}>
                                    {finalResult.article.meta?.theme_label}
                                </span>
                                <h2 className="text-2xl md:text-3xl font-bold mb-2">{finalResult.article.article?.title}</h2>
                                <p style={{ color: 'var(--color-text-dim)' }}>{finalResult.article.article?.subtitle}</p>
                            </div>
                        </div>
                        {finalResult.notionUrl && (
                            <a href={finalResult.notionUrl} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-105"
                                style={{ background: 'var(--color-gold)', color: 'var(--color-brand)' }}>
                                📝 Notion에서 전문 보기 →
                            </a>
                        )}
                    </div>

                    {/* 인트로 */}
                    <div className="glass-card p-6" style={{ borderLeft: '3px solid var(--color-gold)' }}>
                        <p className="text-lg leading-relaxed italic">{finalResult.article.article?.intro}</p>
                    </div>

                    {/* 딥다이브 */}
                    <div className="glass-card p-6">
                        <h3 className="text-lg font-bold mb-3">📌 원포인트 딥다이브</h3>
                        <p className="leading-relaxed whitespace-pre-line" style={{ color: 'var(--color-text-dim)' }}>
                            {finalResult.article.article?.deepdive}
                        </p>
                    </div>

                    {/* 전문가의 시선 */}
                    <div className="glass-card p-6">
                        <h3 className="text-lg font-bold mb-3">🔍 전문가의 시선</h3>
                        <p className="leading-relaxed whitespace-pre-line" style={{ color: 'var(--color-text-dim)' }}>
                            {finalResult.article.article?.expert_touch}
                        </p>
                    </div>

                    {/* 실전 적용 */}
                    <div className="glass-card p-6">
                        <h3 className="text-lg font-bold mb-3">🚀 카페에서 이렇게 써먹어라</h3>
                        <ul className="space-y-2">
                            {(finalResult.article.article?.action_tips || []).map((tip, i) => (
                                <li key={i} className="leading-relaxed" style={{ color: 'var(--color-text-dim)' }}>{tip}</li>
                            ))}
                        </ul>
                    </div>

                    {/* 에디터 코멘트 */}
                    <div className="glass-card p-6" style={{ borderLeft: '3px solid var(--color-accent)' }}>
                        <p className="text-lg font-medium italic" style={{ color: 'var(--color-accent-light)' }}>
                            💬 {finalResult.article.article?.editor_comment}
                        </p>
                    </div>

                    {/* 카드뉴스 대본 */}
                    {finalResult.article.sns_content?.card_news && (
                        <div className="glass-card p-6">
                            <h3 className="text-lg font-bold mb-3">📱 카드뉴스 대본</h3>
                            <div className="space-y-2">
                                {finalResult.article.sns_content.card_news.map((slide, i) => (
                                    <div key={i} className="flex gap-3 items-start p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                        <span className="font-bold text-sm shrink-0" style={{ color: 'var(--color-gold)' }}>{i + 1}</span>
                                        <p className="text-sm" style={{ color: 'var(--color-text-dim)' }}>{slide}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* 해시태그 */}
                    <div className="flex gap-2 flex-wrap">
                        {(finalResult.article.taxonomy?.hashtags || []).map((tag, i) => (
                            <span key={i} className="px-3 py-1 rounded-full text-sm" style={{ background: 'rgba(245,197,66,0.15)', color: 'var(--color-gold)' }}>
                                {tag}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* 푸터 */}
            <footer className="text-center mt-16 pb-8">
                <p className="text-xs" style={{ color: 'var(--color-text-dim)' }}>
                    © 2026 Empty Lab Magazine — Powered by Gemini & Claude AI
                </p>
            </footer>
        </main>
    );
}

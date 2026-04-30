'use client';

export default function KeywordForm({ keyword, setKeyword, isRunning, onRun }) {
    return (
        <section className="glass-card p-5 md:p-6 mb-8">
            <label className="block text-sm font-medium mb-2 text-[var(--color-text-dim)]" htmlFor="keyword-input">
                주제
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
                <input
                    id="keyword-input"
                    type="text"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isRunning && onRun()}
                    placeholder="예: 디카페인, 콜드브루, 오트밀크"
                    disabled={isRunning}
                    className="min-w-0 flex-1 px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] transition-all disabled:opacity-50"
                />
                <button
                    id="generate-btn"
                    onClick={onRun}
                    disabled={isRunning}
                    className="px-5 py-3 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    style={{
                        background: isRunning ? 'var(--color-text-dim)' : 'linear-gradient(135deg, var(--color-accent), var(--color-accent-light))',
                        color: 'white',
                    }}
                >
                    {isRunning ? '생성 중...' : '매거진 생성'}
                </button>
            </div>
        </section>
    );
}

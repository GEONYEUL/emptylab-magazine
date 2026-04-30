export default function ResultView({ finalResult }) {
    if (!finalResult) return null;

    const articleData = finalResult.article || {};
    const article = articleData.article || {};
    const meta = articleData.meta || {};
    const taxonomy = articleData.taxonomy || {};
    const cardNews = articleData.sns_content?.card_news || [];
    const saveWarnings = [finalResult.notionError, finalResult.slackError].filter(Boolean);

    return (
        <section className="space-y-6 animate-fade-in">
            <div className="glass-card p-5 md:p-6">
                <div className="mb-4">
                    <span className="inline-block px-3 py-1 rounded-lg text-xs font-medium mb-3" style={{ background: 'var(--color-accent)', color: 'white' }}>
                        {meta.theme_label || '미분류'}
                    </span>
                    <h2 className="text-2xl md:text-3xl font-bold mb-2">{article.title || '제목 없음'}</h2>
                    {article.subtitle && <p className="text-[var(--color-text-dim)]">{article.subtitle}</p>}
                </div>

                {finalResult.notionUrl && (
                    <a href={finalResult.notionUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-105"
                        style={{ background: 'var(--color-gold)', color: 'var(--color-brand)' }}>
                        Notion에서 전문 보기
                    </a>
                )}

                {saveWarnings.length > 0 && (
                    <div className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-100">
                        {saveWarnings.map((warning, i) => <p key={i}>{warning}</p>)}
                    </div>
                )}
            </div>

            {article.intro && (
                <div className="glass-card p-5 md:p-6" style={{ borderLeft: '3px solid var(--color-gold)' }}>
                    <p className="text-lg leading-relaxed italic">{article.intro}</p>
                </div>
            )}

            <ArticleSection title="트렌드 브리핑" body={article.deepdive} />
            <ArticleSection title="내 한 잔에 어떤 의미?" body={article.lifestyle || article.expert_touch} />

            {Array.isArray(article.action_tips) && article.action_tips.length > 0 && (
                <div className="glass-card p-5 md:p-6">
                    <h3 className="text-lg font-bold mb-3">이렇게 즐겨보세요</h3>
                    <ul className="space-y-2">
                        {article.action_tips.map((tip, i) => (
                            <li key={i} className="leading-relaxed text-[var(--color-text-dim)]">{tip}</li>
                        ))}
                    </ul>
                </div>
            )}

            {article.editor_comment && (
                <div className="glass-card p-5 md:p-6" style={{ borderLeft: '3px solid var(--color-accent)' }}>
                    <p className="text-lg font-medium italic text-[var(--color-accent-light)]">
                        {article.editor_comment}
                    </p>
                </div>
            )}

            {cardNews.length > 0 && (
                <div className="glass-card p-5 md:p-6">
                    <h3 className="text-lg font-bold mb-3">카드뉴스 대본</h3>
                    <div className="space-y-2">
                        {cardNews.map((slide, i) => (
                            <div key={i} className="flex gap-3 items-start p-3 rounded-lg bg-white/[0.03]">
                                <span className="font-bold text-sm shrink-0 text-[var(--color-gold)]">{i + 1}</span>
                                <p className="text-sm text-[var(--color-text-dim)]">{slide}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {Array.isArray(taxonomy.hashtags) && taxonomy.hashtags.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                    {taxonomy.hashtags.map((tag, i) => (
                        <span key={i} className="px-3 py-1 rounded-lg text-sm" style={{ background: 'rgba(245,197,66,0.15)', color: 'var(--color-gold)' }}>
                            {tag}
                        </span>
                    ))}
                </div>
            )}
        </section>
    );
}

function ArticleSection({ title, body }) {
    if (!body) return null;

    return (
        <div className="glass-card p-5 md:p-6">
            <h3 className="text-lg font-bold mb-3">{title}</h3>
            <p className="leading-relaxed whitespace-pre-line text-[var(--color-text-dim)]">
                {body}
            </p>
        </div>
    );
}

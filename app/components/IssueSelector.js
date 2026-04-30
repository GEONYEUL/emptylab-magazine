export default function IssueSelector({ issues, onSelect, isRunning }) {
    if (!issues || issues.length === 0) return null;

    return (
        <section className="glass-card p-5 md:p-6 mb-8 animate-fade-in">
            <h3 className="text-lg font-bold mb-4 text-[var(--color-gold)]">
                어떤 이슈를 다룰까요?
            </h3>
            <div className="flex flex-col gap-4">
                {issues.map((issue) => (
                    <button
                        key={issue.id}
                        onClick={() => onSelect(issue)}
                        disabled={isRunning}
                        className="text-left p-4 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <h4 className="font-semibold text-[var(--color-text)] mb-1">{issue.title}</h4>
                        <p className="text-sm text-[var(--color-text-dim)] mb-2">{issue.description}</p>
                        <div className="flex flex-wrap gap-2">
                            {issue.keywords?.map((kw) => (
                                <span key={kw} className="text-xs px-2 py-1 bg-black/40 rounded text-[var(--color-accent-light)]">
                                    #{kw}
                                </span>
                            ))}
                        </div>
                    </button>
                ))}
            </div>
        </section>
    );
}

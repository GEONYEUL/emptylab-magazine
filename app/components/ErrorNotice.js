export default function ErrorNotice({ error }) {
    if (!error) return null;

    return (
        <section className="glass-card p-5 md:p-6 mb-8 border-l-4 animate-fade-in" style={{ borderColor: 'var(--color-accent)' }}>
            <p className="font-medium text-[var(--color-accent-light)]">오류 발생</p>
            <p className="mt-1 text-sm text-[var(--color-text-dim)]">{error}</p>
        </section>
    );
}

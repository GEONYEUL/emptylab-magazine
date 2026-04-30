const STEPS = [
    { id: 'collect', label: '뉴스 수집', desc: 'RSS 소스에서 기사를 수집합니다' },
    { id: 'preprocess', label: 'Gemini 전처리', desc: 'AI가 핵심 팩트를 추출합니다' },
    { id: 'write', label: 'Claude 글쓰기', desc: '수석 에디터가 칼럼을 작성합니다' },
    { id: 'save', label: '발행', desc: 'Notion 저장 + Slack 알림' },
];

function stepSummary(step, stepResults) {
    if (step.id === 'collect') return `${stepResults.collect.count}건 수집`;
    if (step.id === 'preprocess') return stepResults.preprocess.data?.theme_label || '완료';
    if (step.id === 'write') return '완료';
    if (step.id === 'save') {
        if (stepResults.save?.notionUrl) return '발행 완료';
        return '알림 완료';
    }
    return '';
}

export default function PipelineSteps({ currentStep, stepResults, isRunning }) {
    if (currentStep < 0) return null;

    return (
        <section className="glass-card p-5 md:p-6 mb-8 animate-fade-in">
            <h3 className="text-sm font-medium mb-4 text-[var(--color-text-dim)]">
                파이프라인 진행 상황
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {STEPS.map((step, i) => (
                    <div key={step.id} className="min-h-24 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <div className={`step-dot ${i < currentStep ? 'done' : i === currentStep ? 'active' : 'waiting'}`} />
                            <span className="text-sm font-medium" style={{ color: i <= currentStep ? 'var(--color-text)' : 'var(--color-text-dim)' }}>
                                {step.label}
                            </span>
                        </div>
                        {i === currentStep && isRunning && (
                            <p className="text-xs text-[var(--color-accent-light)]">{step.desc}...</p>
                        )}
                        {stepResults[step.id] && i < currentStep && (
                            <p className="text-xs text-green-300">{stepSummary(step, stepResults)}</p>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

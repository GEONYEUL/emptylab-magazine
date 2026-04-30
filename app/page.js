'use client';

import { useState } from 'react';
import ErrorNotice from './components/ErrorNotice.js';
import KeywordForm from './components/KeywordForm.js';
import PipelineSteps from './components/PipelineSteps.js';
import ResultView from './components/ResultView.js';

async function safeFetch(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let data;

    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`서버 오류 (${res.status}): ${text.substring(0, 200)}`);
    }

    if (!res.ok) {
        throw new Error(data.error || `서버 오류 (${res.status})`);
    }

    return data;
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

        const normalizedKeyword = keyword.trim() || null;

        try {
            setCurrentStep(0);
            const collectData = await safeFetch('/api/collect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword: normalizedKeyword }),
            });
            if (!collectData.success) throw new Error(collectData.error || '수집 실패');
            setStepResults(prev => ({ ...prev, collect: collectData }));

            setCurrentStep(1);
            const preprocessData = await safeFetch('/api/preprocess', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articles: collectData.articles, keyword: normalizedKeyword }),
            });
            if (!preprocessData.success) {
                if (preprocessData.data?.error === 'INSUFFICIENT_DATA') {
                    throw new Error(`기사 부족 (${preprocessData.data.count}건) - 다른 키워드로 시도해 보세요`);
                }
                throw new Error(preprocessData.error || preprocessData.data?.message || '전처리 실패');
            }
            setStepResults(prev => ({ ...prev, preprocess: preprocessData }));

            setCurrentStep(2);
            const writeData = await safeFetch('/api/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiOutput: preprocessData.data }),
            });
            if (!writeData.success) throw new Error(writeData.error || '글쓰기 실패');
            setStepResults(prev => ({ ...prev, write: writeData }));

            setCurrentStep(3);
            const saveData = await safeFetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ finalData: writeData.data }),
            });
            setStepResults(prev => ({ ...prev, save: saveData }));

            setCurrentStep(4);
            setFinalResult({
                article: writeData.data,
                notionUrl: saveData.notionUrl,
                notionError: saveData.notionError,
                slackError: saveData.slackError,
            });
        } catch (err) {
            setError(err.message);
            setCurrentStep(-1);
        } finally {
            setIsRunning(false);
        }
    }

    return (
        <main className="min-h-screen px-4 py-8 md:py-12 max-w-4xl mx-auto">
            <header className="mb-8 md:mb-10">
                <h1 className="text-3xl md:text-4xl font-bold mb-2 tracking-tight">
                    <span className="text-[var(--color-gold)]">Empty Lab</span> Magazine
                </h1>
                <p className="text-[var(--color-text-dim)]">
                    커피 산업 뉴스룸
                </p>
            </header>

            <KeywordForm
                keyword={keyword}
                setKeyword={setKeyword}
                isRunning={isRunning}
                onRun={runPipeline}
            />

            <PipelineSteps currentStep={currentStep} stepResults={stepResults} isRunning={isRunning} />
            <ErrorNotice error={error} />
            <ResultView finalResult={finalResult} />

            <footer className="text-center mt-16 pb-8">
                <p className="text-xs text-[var(--color-text-dim)]">
                    © 2026 Empty Lab Magazine
                </p>
            </footer>
        </main>
    );
}

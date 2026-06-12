'use client';

import { useState } from 'react';
import ErrorNotice from './components/ErrorNotice.js';
import KeywordForm from './components/KeywordForm.js';
import PipelineSteps from './components/PipelineSteps.js';
import ResultView from './components/ResultView.js';
import IssueSelector from './components/IssueSelector.js';

// 일시적 서버 에러(529 과부하, 500 내부오류 등)에 대한 재시도 대기 함수
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeFetch(url, options, retries = 2) {
    const res = await fetch(url, options);
    const text = await res.text();
    let data;

    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`서버 오류 (${res.status}): ${text.substring(0, 200)}`);
    }

    if (!res.ok) {
        // 529(과부하), 500(내부 오류) 등 일시적 에러 → 자동 재시도
        const retryableStatuses = [429, 500, 502, 503, 504, 529];
        if (retryableStatuses.includes(res.status) && retries > 0) {
            // 서버 측에서 이미 재시도 로직이 있으므로, 클라이언트는 짧게 대기
            const delay = (3 - retries) * 3000 + 2000; // 2초, 5초 순으로 대기
            console.warn(`[safeFetch] ${res.status} 에러, ${delay / 1000}초 후 재시도 (남은 횟수: ${retries})`);
            await sleep(delay);
            return safeFetch(url, options, retries - 1);
        }

        // 사용자에게 더 친절한 에러 메시지 제공
        if (res.status === 529) {
            throw new Error('AI 서버가 현재 과부하 상태입니다. 잠시 후 다시 시도해 주세요.');
        }
        if (res.status === 504) {
            throw new Error('서버 응답 시간이 초과되었습니다. AI 처리에 시간이 오래 걸릴 수 있으니, 잠시 후 다시 시도해 주세요.');
        }
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

    const [issues, setIssues] = useState([]);
    const [selectedIssue, setSelectedIssue] = useState(null);

    async function fetchIssues() {
        setIsRunning(true);
        setError(null);
        setFinalResult(null);
        setStepResults({});
        setIssues([]);
        setSelectedIssue(null);

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
            const issuesData = await safeFetch('/api/extract-issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articles: collectData.articles, keyword: normalizedKeyword }),
            });
            if (!issuesData.success) {
                if (issuesData.data?.error === 'INSUFFICIENT_DATA') {
                    throw new Error(`기사 부족 (${issuesData.data.count}건) - 다른 키워드로 시도해 보세요`);
                }
                throw new Error(issuesData.error || issuesData.data?.message || '이슈 추출 실패');
            }
            setStepResults(prev => ({ ...prev, 'extract-issues': issuesData }));
            
            // 이슈 선택 UI 표시를 위해 실행 상태 중지
            setIssues(issuesData.data.issues || []);
            setIsRunning(false);

        } catch (err) {
            setError(err.message);
            setCurrentStep(-1);
            setIsRunning(false);
        }
    }

    async function continuePipeline(issue) {
        setSelectedIssue(issue);
        setIsRunning(true);
        setError(null);

        try {
            setCurrentStep(2);
            const preprocessData = await safeFetch('/api/preprocess', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    articles: stepResults.collect.articles, 
                    keyword: issue.title 
                }),
            });
            if (!preprocessData.success) throw new Error(preprocessData.error || '전처리 실패');
            setStepResults(prev => ({ ...prev, preprocess: preprocessData }));

            setCurrentStep(3);
            const writeData = await safeFetch('/api/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiOutput: preprocessData.data }),
            });
            if (!writeData.success) throw new Error(writeData.error || '글쓰기 실패');
            setStepResults(prev => ({ ...prev, write: writeData }));

            setCurrentStep(4);
            const reviewData = await safeFetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    articleData: writeData.data,
                    originalFacts: preprocessData.data
                }),
            });
            if (!reviewData.success) throw new Error(reviewData.error || '팩트체크 리뷰 실패');
            setStepResults(prev => ({ ...prev, review: reviewData }));

            setCurrentStep(5);
            const saveData = await safeFetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ finalData: reviewData.data }),
            });
            setStepResults(prev => ({ ...prev, save: saveData }));

            setCurrentStep(6);
            setFinalResult({
                article: reviewData.data,
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
                onRun={fetchIssues}
            />

            <PipelineSteps currentStep={currentStep} stepResults={stepResults} isRunning={isRunning} />
            
            {!selectedIssue && !isRunning && issues.length > 0 && (
                <IssueSelector issues={issues} onSelect={continuePipeline} isRunning={isRunning} />
            )}

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

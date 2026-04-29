import './globals.css';

export const metadata = {
    title: 'Empty Lab Magazine | AI 커피 뉴스룸',
    description: '커피 산업 뉴스를 AI가 매거진 칼럼으로 자동 가공하는 뉴스룸 파이프라인',
};

export default function RootLayout({ children }) {
    return (
        <html lang="ko">
            <body>{children}</body>
        </html>
    );
}

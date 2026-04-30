// lib/slack.js
import axios from 'axios';
import { getOptionalEnv } from './env.js';

export async function sendSlackNotification(parsedData, notionUrl) {
    const webhookUrl = getOptionalEnv('SLACK_WEBHOOK_URL');
    if (!webhookUrl) return;

    if (!parsedData || parsedData.error) {
        if (parsedData?.error) {
            await axios.post(webhookUrl, {
                text: `⚠️ [Empty Lab] 파이프라인 경고: ${parsedData.message || parsedData.error}`,
            }).catch(() => {});
        }
        return;
    }

    const meta = parsedData.meta || {};
    const article = parsedData.article || {};
    const notification = parsedData.notification || {};
    const title = article.title || '제목 없음';
    const summary = Array.isArray(notification.slack_summary) ? notification.slack_summary : [];
    const blocks = [
        { type: "header", text: { type: "plain_text", text: "☕ 엠프티랩 | 오늘의 아티클 생성 완료", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `*${title}*\n_${meta.theme_label || '미분류'}_` } },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "*📝 3줄 요약:*\n" + summary.map(s => `• ${s}`).join("\n") } },
        { type: "section", text: { type: "mrkdwn", text: `*💡 인사이트:*\n> ${notification.slack_insight || ''}` } },
    ];

    if (notionUrl) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `👉 *<${notionUrl}|노션에서 전문 읽기>*` } });
    }

    await axios.post(webhookUrl, {
        text: `☕ 엠프티랩 | ${title}`,
        blocks,
    });
}

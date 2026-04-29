// lib/slack.js
import axios from 'axios';

export async function sendSlackNotification(parsedData, notionUrl) {
    if (!process.env.SLACK_WEBHOOK_URL) return;

    if (!parsedData || parsedData.error) {
        if (parsedData?.error) {
            await axios.post(process.env.SLACK_WEBHOOK_URL, {
                text: `⚠️ [Empty Lab] 파이프라인 경고: ${parsedData.message || parsedData.error}`,
            }).catch(() => {});
        }
        return;
    }

    const { meta, article, notification } = parsedData;
    const blocks = [
        { type: "header", text: { type: "plain_text", text: "☕ 엠프티랩 | 오늘의 아티클 생성 완료", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `*${article.title}*\n_${meta.theme_label}_` } },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "*📝 3줄 요약:*\n" + (notification.slack_summary || []).map(s => `• ${s}`).join("\n") } },
        { type: "section", text: { type: "mrkdwn", text: `*💡 인사이트:*\n> ${notification.slack_insight || ''}` } },
    ];

    if (notionUrl) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `👉 *<${notionUrl}|노션에서 전문 읽기>*` } });
    }

    await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `☕ 엠프티랩 | ${article.title}`,
        blocks,
    });
}

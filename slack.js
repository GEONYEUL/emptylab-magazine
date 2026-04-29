const axios = require('axios');

async function sendSlackNotification(parsedData, notionUrl) {
    console.log('[DEBUG] 🔔 Slack으로 알림을 전송합니다...');

    if (!parsedData || parsedData.error) {
        // 에러 알림도 슬랙으로 보냄
        if (parsedData && parsedData.error) {
            try {
                await axios.post(process.env.SLACK_WEBHOOK_URL, {
                    text: `⚠️ [Empty Lab Magazine] 파이프라인 경고: ${parsedData.message || parsedData.error}`,
                });
                console.log('[DEBUG] ⚠️ 에러 알림을 Slack으로 전송했습니다.');
            } catch (e) {
                console.error('[ERROR] Slack 에러 알림 전송 실패:', e.message);
            }
        }
        return;
    }

    try {
        const { meta, article, notification } = parsedData;

        const blocks = [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "☕ 엠프티랩 | 오늘의 아티클 생성 완료",
                    emoji: true,
                },
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*${article.title}*\n_${meta.theme_label}_`,
                },
            },
            { type: "divider" },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "*📝 3줄 요약:*\n" + (notification.slack_summary || []).map(s => `• ${s}`).join("\n"),
                },
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*💡 에디터 인사이트:*\n> ${notification.slack_insight || ''}`,
                },
            },
        ];

        // 노션 URL이 있을 때만 버튼 블록 추가
        if (notionUrl) {
            blocks.push({
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "📝 노션에서 보기",
                            emoji: true,
                        },
                        url: notionUrl,
                    },
                ],
            });
        }

        await axios.post(process.env.SLACK_WEBHOOK_URL, {
            text: `☕ 엠프티랩 | 오늘의 아티클: ${article.title}`,
            blocks,
        });

        console.log('[DEBUG] ✅ Slack 알림 전송 완료');
    } catch (error) {
        console.error('[ERROR] ❌ Slack 알림 전송 중 오류 발생:', error.message);
        throw error;
    }
}

module.exports = { sendSlackNotification };

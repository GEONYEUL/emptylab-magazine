const REQUIRED_ENV_LABELS = {
    GEMINI_API_KEY: 'Gemini API key',
    ANTHROPIC_API_KEY: 'Anthropic API key',
    NOTION_API_KEY: 'Notion API key',
    NOTION_DATABASE_ID: 'Notion database id',
};

export function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        const label = REQUIRED_ENV_LABELS[name] || name;
        throw new Error(`Missing required environment variable: ${name} (${label})`);
    }
    return value;
}

export function getOptionalEnv(name) {
    return process.env[name] || null;
}

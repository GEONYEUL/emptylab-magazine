export async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

export function badRequest(message, details = null) {
    return Response.json(
        { success: false, error: message, details },
        { status: 400 }
    );
}

export function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeKeyword(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') return { error: 'keyword must be a string' };

    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > 80) return { error: 'keyword must be 80 characters or fewer' };
    return trimmed;
}

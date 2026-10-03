export function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
export function textResponse(text, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}
// Routes IMDb GraphQL GETs by operationName to handler(op, variables) -> data object.
export function imdbStub(handler, calls = []) {
    return async (url) => {
        const u = new URL(url);
        const op = u.searchParams.get('operationName');
        const vars = JSON.parse(u.searchParams.get('variables'));
        calls.push({ op, vars });
        const data = handler(op, vars);
        return data instanceof Error ? jsonResponse({ errors: [{ message: data.message }] }) : jsonResponse({ data });
    };
}

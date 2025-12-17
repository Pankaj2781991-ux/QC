import { ApiError } from '../../lib/errors.js';
export class GenericApiKeyJsonConnector {
    static type = 'GENERIC_API_KEY_JSON_V1';
    type = GenericApiKeyJsonConnector.type;
    authType = 'API_KEY';
    async fetchStructuredData(input) {
        const baseUrl = String(input.config.config.baseUrl ?? '');
        const path = String(input.config.config.path ?? '');
        const apiKeyHeader = String(input.config.config.apiKeyHeader ?? 'Authorization');
        const apiKeyPrefix = String(input.config.config.apiKeyPrefix ?? 'Bearer ');
        if (!baseUrl || !path) {
            throw new ApiError('FAILED_PRECONDITION', 'Connector config must include baseUrl and path', 412);
        }
        const apiKey = input.credentials.apiKey;
        if (typeof apiKey !== 'string' || apiKey.length < 8) {
            throw new ApiError('FAILED_PRECONDITION', 'Missing/invalid apiKey credential', 412);
        }
        const url = new URL(path, baseUrl);
        if (input.query) {
            for (const [k, v] of Object.entries(input.query)) {
                if (v === undefined || v === null)
                    continue;
                url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
            }
        }
        const resp = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                [apiKeyHeader]: `${apiKeyPrefix}${apiKey}`,
                Accept: 'application/json'
            }
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new ApiError('FAILED_PRECONDITION', `Connector HTTP ${resp.status}: ${text.slice(0, 500)}`, 412);
        }
        const data = (await resp.json());
        if (typeof data === 'string')
            return { kind: 'text', text: data };
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return { kind: 'record', record: data };
        }
        // For arrays, emit record wrapper to keep deterministic.
        return { kind: 'record', record: { value: data } };
    }
}

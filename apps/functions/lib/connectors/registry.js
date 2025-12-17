import { ApiError } from '../lib/errors.js';
import { GenericApiKeyJsonConnector } from './impl/genericApiKeyJson.js';
const registry = {
    [GenericApiKeyJsonConnector.type]: new GenericApiKeyJsonConnector()
};
export function getConnectorForIntegration(config) {
    const connector = registry[config.type];
    if (!connector)
        throw new ApiError('FAILED_PRECONDITION', `Unknown connector type: ${config.type}`, 412);
    if (connector.authType !== config.authType) {
        throw new ApiError('FAILED_PRECONDITION', `Connector authType mismatch: expected ${connector.authType}, got ${config.authType}`, 412);
    }
    return connector;
}

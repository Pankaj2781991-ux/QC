export type ConnectorAuthType = 'API_KEY' | 'OAUTH';

export type ConnectorType = string;

export type ConnectorConfig = {
  tenantId: string;
  integrationId: string;
  type: ConnectorType;
  authType: ConnectorAuthType;
  // Non-secret configuration (e.g. baseUrl, account id)
  config: Record<string, unknown>;
};

export type NormalizedExternalData =
  | { kind: 'record'; record: Record<string, unknown> }
  | { kind: 'text'; text: string }
  | { kind: 'table'; columns: string[]; rows: unknown[] };

export interface Connector {
  readonly type: ConnectorType;
  readonly authType: ConnectorAuthType;

  fetchStructuredData(input: {
    config: ConnectorConfig;
    // Decrypted credentials are provided by server runtime only.
    credentials: Record<string, unknown>;
    // Connector-specific query params
    query?: Record<string, unknown>;
  }): Promise<NormalizedExternalData>;
}

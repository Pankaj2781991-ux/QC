import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

export async function storeApiKeySecret(input: {
  projectId: string;
  tenantId: string;
  integrationId: string;
  apiKey: string;
}): Promise<{ secretResourceName: string }> {
  const parent = `projects/${input.projectId}`;
  const secretId = `qc-${input.tenantId}-${input.integrationId}-apikey`;

  // Create secret if missing.
  const [secrets] = await client.listSecrets({ parent });
  const exists = secrets.some((s) => s.name?.endsWith(`/secrets/${secretId}`));

  if (!exists) {
    await client.createSecret({
      parent,
      secretId,
      secret: {
        replication: { automatic: {} }
      }
    });
  }

  const secretName = `${parent}/secrets/${secretId}`;
  await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(input.apiKey, 'utf8') }
  });

  return { secretResourceName: secretName };
}

export async function accessSecretString(secretResourceName: string): Promise<string> {
  const [version] = await client.accessSecretVersion({ name: `${secretResourceName}/versions/latest` });
  const data = version.payload?.data;
  if (!data) throw new Error('Secret payload missing');
  return Buffer.from(data).toString('utf8');
}

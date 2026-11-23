import { dataset } from '../catalogue/client.js';

export async function accountRequest(path, { method = 'GET', data, signal } = {}) {
  const response = await fetch('/api/v1' + path, {
    method, signal, credentials: 'same-origin', cache: 'no-store',
    ...(data !== undefined && {
      body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
    }),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(body?.message ?? 'The account request could not be completed.');
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  if (response.headers.get('X-BenefitBridge-Dataset') !== dataset) {
    throw new Error('The account is connected to a different data environment.');
  }
  return body;
}

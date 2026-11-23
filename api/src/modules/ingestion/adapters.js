import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { opaqueId, timestamp, webUrl } from './file-adapter.js';

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

export class FeedError extends Error {
  constructor(code, retryable = false, retryAfterMs = 0) {
    super(code);
    Object.assign(this, { code, retryable, retryAfterMs });
  }
}

export const pageSchema = z.strictObject({
  records: z.array(z.unknown()).max(1000),
  nextCursor: z.string().min(1).max(1024).nullable(),
  snapshotKey: z.string().min(1).max(1024).optional(),
  checkpoint: z.string().min(1).max(1024).optional(),
  complete: z.boolean().optional(),
});

export const sourceSchema = z.strictObject({
  id: opaqueId,
  name: z.string().trim().min(1).max(100),
  baseUrl: webUrl,
  accessPermissions: z.string().trim().min(1).max(4000),
  retentionPolicy: z.enum(['reference_only', 'permitted_original']),
  evidenceOrigins: z.array(z.string().url().refine(value => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.href === url.origin + '/';
  })).min(1).max(30).transform(values => values.map(value => new URL(value).origin)),
});

export async function withRetry(fetchPage, { sleep = wait, attempts = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchPage();
    } catch (error) {
      if (!error.retryable || attempt + 1 >= attempts || error.retryAfterMs > 60_000) throw error;
      await sleep(Math.max(error.retryAfterMs, Math.min(8000, 250 * 2 ** attempt)));
    }
  }
}

export async function fileAdapter(path, dataset) {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new FeedError('FILE_TOO_LARGE');
  const input = JSON.parse(await readFile(path, 'utf8'));
  const metadata = sourceSchema.parse({
    ...input.source,
    evidenceOrigins: input.source?.evidenceOrigins ?? [new URL(input.source.baseUrl).origin],
  });
  if (input.dataset !== dataset || !Array.isArray(input.records) || input.records.length > 100_000 ||
      !timestamp.safeParse(input.retrievedAt).success) throw new FeedError('INVALID_FILE');
  const records = input.records.map(value => {
    if (Object.hasOwn(value ?? {}, 'record')) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { sourceUpdatedAt, ...record } = value;
    return { record, updatedAt: sourceUpdatedAt ?? input.retrievedAt };
  });
  const key = digest(input);
  return {
    metadata, incremental: false,
    async page({ cursor }) {
      const start = Number(cursor ?? 0);
      const end = start + 500;
      return {
        records: records.slice(start, end), snapshotKey: key,
        nextCursor: end < records.length ? String(end) : null, complete: end >= records.length,
      };
    },
  };
}

async function readBoundedJson(response) {
  if (!response.body || !/application\/(?:[a-z0-9.+-]+\+)?json/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new FeedError('EXPECTED_JSON');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new FeedError('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new FeedError('INVALID_JSON');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function httpAdapter({ endpoint, authorization, metadata, incremental, requestIntervalMs = 1000, fetcher = fetch }) {
  const source = sourceSchema.parse(metadata);
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || base.username || base.password || base.hash ||
      !source.evidenceOrigins.includes(base.origin)) throw new FeedError('INVALID_PROVIDER_ENDPOINT');
  let lastRequestAt = 0;
  return {
    metadata: source, incremental,
    async page({ mode, cursor, checkpoint }) {
      const url = new URL(base);
      url.searchParams.set('mode', mode);
      if (cursor) url.searchParams.set('cursor', cursor);
      if (checkpoint && mode === 'incremental') url.searchParams.set('checkpoint', checkpoint);
      await wait(Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt)));
      lastRequestAt = Date.now();
      try {
        const response = await fetcher(url, {
          redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { Accept: 'application/json', ...(authorization && { Authorization: authorization }) },
        });
        if (!response.ok) {
          await response.body?.cancel();
          const header = response.headers.get('retry-after');
          const retryAfter = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now())) : 0;
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new FeedError('HTTP_' + response.status, retryable, retryAfter || 0);
        }
        return await readBoundedJson(response);
      } catch (error) {
        if (error instanceof FeedError) throw error;
        throw new FeedError('PROVIDER_UNAVAILABLE', true);
      }
    },
  };
}

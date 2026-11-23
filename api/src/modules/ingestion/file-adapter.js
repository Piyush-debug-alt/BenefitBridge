import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { governmentLevels, lifecycleStatuses, stateCode, verificationStatuses } from '../catalogue/validation.js';
import { eligibilitySchema } from '../matching/criteria.js';

const shortText = z.string().trim().min(1).max(100);
const paragraph = z.string().trim().min(1).max(4000);
export const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
export const webUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).max(2048)
  .refine(value => !new URL(value).username && !new URL(value).password, 'Link must omit credentials.');
export const timestamp = z.iso.datetime({ offset: true });
const sourceReference = z.strictObject({ label: shortText, url: webUrl });

export const record = z.strictObject({
  externalRecordId: opaqueId,
  canonicalName: z.string().trim().min(1).max(180),
  description: paragraph,
  keywords: z.array(shortText).max(30).default([]),
  goalTags: z.array(shortText).max(20).default([]),
  categoryIds: z.array(shortText).min(1).max(15),
  benefitTypes: z.array(shortText).max(15).default([]),
  governmentLevel: z.enum(governmentLevels),
  issuer: shortText,
  nationwide: z.boolean(),
  stateCodes: z.array(stateCode).max(40).default([]),
  lifecycleStatus: z.enum(lifecycleStatuses),
  verificationStatus: z.enum(verificationStatuses),
  sourceRefs: z.array(sourceReference).min(1).max(15),
  applicationUrl: webUrl.optional(),
  applicationDeadline: z.iso.date().optional(),
  benefits: z.array(paragraph).max(20).default([]),
  eligibilityText: paragraph.optional(),
  eligibility: eligibilitySchema.optional(),
  requiredDocuments: z.array(shortText).max(30).default([]),
  lastVerifiedAt: timestamp.optional(),
}).superRefine((value, context) => {
  const problems = [
    [value.nationwide && value.governmentLevel !== 'central', 'nationwide', 'Nationwide scope requires central government level.'],
    [value.nationwide && value.stateCodes.length > 0, 'stateCodes', 'Nationwide records must omit state codes.'],
    [value.governmentLevel === 'state' && value.stateCodes.length === 0, 'stateCodes', 'State records require at least one state code.'],
    [value.verificationStatus === 'verified' && !value.lastVerifiedAt, 'lastVerifiedAt', 'Verified information requires a verification date.'],
    [value.eligibility && value.verificationStatus !== 'verified', 'eligibility', 'Structured eligibility requires a verified scheme.'],
    [value.eligibility && !value.sourceRefs.some(ref => ref.url === value.eligibility.evidenceUrl), 'eligibility', 'Eligibility evidence must be one of the scheme source references.'],
  ];
  for (const [condition, field, message] of problems) {
    if (condition) context.addIssue({ code: 'custom', path: [field], message });
  }
});

const fixture = z.strictObject({
  dataset: z.enum(['authorized', 'synthetic']),
  source: z.strictObject({
    id: opaqueId,
    name: shortText,
    baseUrl: webUrl,
    accessPermissions: paragraph,
    retentionPolicy: z.literal('reference_only'),
  }),
  retrievedAt: timestamp,
  records: z.array(record).min(1).max(1000),
}).superRefine((value, context) => {
  const ids = new Set();
  value.records.forEach((entry, index) => {
    if (ids.has(entry.externalRecordId)) {
      context.addIssue({ code: 'custom', path: ['records', index, 'externalRecordId'], message: 'Duplicate source record ID.' });
    }
    ids.add(entry.externalRecordId);
    if (entry.lastVerifiedAt && Date.parse(entry.lastVerifiedAt) > Date.parse(value.retrievedAt)) {
      context.addIssue({ code: 'custom', path: ['records', index, 'lastVerifiedAt'], message: 'Verification date must precede retrieval.' });
    }
  });
});

export function parseFixture(input, dataset) {
  const parsed = fixture.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => issue.path.join('.') + ' (' + issue.message + ')');
    throw new Error('Invalid fixture: ' + details.join('; '));
  }

  const value = parsed.data;
  if (value.dataset !== dataset) {
    throw new Error('Fixture dataset does not match the target environment.');
  }

  const urls = [value.source.baseUrl, ...value.records.flatMap(record => [
    ...record.sourceRefs.map(reference => reference.url),
    ...(record.applicationUrl ? [record.applicationUrl] : []),
  ])];
  const isDemoUrl = url => new URL(url).hostname.endsWith('.invalid');
  if (urls.some(url => isDemoUrl(url) !== (dataset === 'synthetic'))) {
    throw new Error('Synthetic links must use .invalid domains, which are reserved for the demo.');
  }

  return value;
}

export async function readFixture(path, dataset) {
  let input;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Could not read the fixture as JSON.');
  }
  return parseFixture(input, dataset);
}

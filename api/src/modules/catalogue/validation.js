import { z } from 'zod';

export const datasets = ['authorized', 'synthetic'];
export const lifecycleStatuses = ['active', 'closed', 'unknown'];
export const verificationStatuses = ['verified', 'stale', 'under_review', 'disputed', 'unverified'];
export const governmentLevels = ['central', 'state'];
export const stateCode = z.string().trim().regex(/^[A-Za-z]{2}$/).transform(value => value.toUpperCase());
const filterText = z.string().trim().min(1).max(100);
const decimal = (max, fallback) => z.string().regex(/^[1-9][0-9]{0,3}$/)
  .transform(Number).pipe(z.number().int().max(max)).default(fallback);

export const listQuery = z.strictObject({
  q: z.string().trim().max(160).optional(),
  goal: filterText.optional(),
  state: stateCode.optional(),
  category: filterText.optional(),
  benefitType: filterText.optional(),
  issuer: filterText.optional(),
  governmentLevel: z.enum(governmentLevels).optional(),
  lifecycleStatus: z.enum(lifecycleStatuses).optional(),
  page: decimal(1000, 1),
  limit: decimal(50, 10),
});

export const schemeId = z.string().regex(/^[a-f\d]{24}$/i);

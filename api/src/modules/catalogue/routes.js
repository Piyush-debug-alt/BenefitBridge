import { Router } from 'express';
import { HttpError, validate } from '../../middleware/http.js';
import { listQuery, schemeId } from './validation.js';

const cardFields = 'canonicalName description categoryIds benefitTypes governmentLevel issuer nationwide stateCodes lifecycleStatus verificationStatus lastVerifiedAt';
const detailFields = cardFields + ' benefits eligibilityText requiredDocuments sourceRefs applicationUrl lastSyncedAt';

function buildFilter(base, filters) {
  const filter = {
    ...base,
    lifecycleStatus: filters.lifecycleStatus ?? { $ne: 'closed' },
  };

  if (filters.q) filter.$text = { $search: filters.q };
  if (filters.goal) filter.goalTags = filters.goal;
  if (filters.category) filter.categoryIds = filters.category;
  if (filters.issuer) filter.issuer = filters.issuer;
  if (filters.benefitType) filter.benefitTypes = filters.benefitType;
  if (filters.governmentLevel) filter.governmentLevel = filters.governmentLevel;
  if (filters.state) {
    filter.$or = [
      { governmentLevel: 'central', nationwide: true },
      { stateCodes: filters.state },
    ];
  }

  return filter;
}

export function catalogueRouter(Scheme, dataset) {
  const router = Router();
  const published = { dataset, publicationStatus: 'published' };

  router.get('/schemes', async (req, res) => {
    const filters = validate(listQuery, req.query);
    const { page, limit } = filters;
    const filter = buildFilter(published, filters);
    const query = Scheme.find(filter).select(cardFields);
    if (filters.q) query.sort({ score: { $meta: 'textScore' }, canonicalName: 1, _id: 1 });
    else query.sort({ canonicalName: 1, _id: 1 });

    const [items, total] = await Promise.all([
      query.skip((page - 1) * limit).limit(limit).lean(),
      Scheme.countDocuments(filter),
    ]);

    res.json({ dataset, items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  });

  router.get('/facets', async (_req, res) => {
    const fields = {
      categories: 'categoryIds',
      benefitTypes: 'benefitTypes',
      issuers: 'issuer',
      states: 'stateCodes',
      governmentLevels: 'governmentLevel',
    };
    const entries = await Promise.all(Object.entries(fields).map(async ([key, field]) => {
      const values = await Scheme.distinct(field, published);
      return [key, values.sort((left, right) => left.localeCompare(right, 'en'))];
    }));
    res.json({ dataset, ...Object.fromEntries(entries) });
  });

  router.get('/schemes/:schemeId', async (req, res) => {
    const id = validate(schemeId, req.params.schemeId);
    const item = await Scheme.findOne({ ...published, _id: id }).select(detailFields).lean();
    if (!item) throw new HttpError(404, 'SCHEME_NOT_FOUND', 'This scheme could not be found.');

    res.json({ dataset, item });
  });

  return router;
}

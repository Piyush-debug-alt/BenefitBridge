import { Router } from 'express';
import { HttpError, validate } from '../../middleware/http.js';
import { listQuery, schemeId } from './validation.js';

const cardFields = 'canonicalName description categoryIds benefitTypes governmentLevel issuer nationwide stateCodes lifecycleStatus verificationStatus lastVerifiedAt';
const detailFields = cardFields + ' benefits eligibilityText requiredDocuments sourceRefs applicationUrl applicationDeadline lastSyncedAt relationships disputedFields sourceId currentVersionId';

export function buildFilter(base, filters) {
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

export function searchSchemes(Scheme, published, filters) {
  const { page, limit } = filters;
  const filter = buildFilter(published, filters);
  const query = Scheme.find(filter).select(cardFields);
  if (filters.q) query.sort({ score: { $meta: 'textScore' }, canonicalName: 1, _id: 1 });
  else query.sort({ canonicalName: 1, _id: 1 });
  return [query.skip((page - 1) * limit).limit(limit).lean(), Scheme.countDocuments(filter)];
}

export function catalogueRouter(Scheme, dataset, SyncSource) {
  const router = Router();
  const published = { dataset, publicationStatus: 'published' };
  const countsInProgress = new Map();

  function sharedCount(count) {
    const key = JSON.stringify(count.getFilter());
    if (!countsInProgress.has(key)) {
      countsInProgress.set(key, count.exec().finally(() => countsInProgress.delete(key)));
    }
    return countsInProgress.get(key);
  }

  router.get('/schemes', async (req, res) => {
    const filters = validate(listQuery, req.query);
    const { page, limit } = filters;
    const [list, count] = searchSchemes(Scheme, published, filters);
    const [items, total] = await Promise.all([list, sharedCount(count)]);

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
    const visible = { ...published, verificationStatus: { $in: ['verified', 'under_review', 'disputed', 'stale'] } };
    const [targets, children, source] = await Promise.all([
      item.relationships?.length
        ? Scheme.find({ ...visible, _id: { $in: item.relationships.map(link => link.targetId) } }).select('canonicalName').lean()
        : [],
      Scheme.find({ ...visible, relationships: { $elemMatch: { kind: 'variant_of', targetId: id } } })
        .select('canonicalName stateCodes').sort('canonicalName').limit(50).lean(),
      SyncSource?.findById(item.sourceId).select('lastSuccessAt lastFailureAt').lean(),
    ]);
    const names = new Map(targets.map(target => [String(target._id), target.canonicalName]));
    const { sourceId, currentVersionId, relationships, ...publicItem } = item;
    res.json({ dataset, item: {
      ...publicItem,
      relationships: (relationships ?? []).flatMap(link => names.has(String(link.targetId))
        ? [{ ...link, name: names.get(String(link.targetId)) }] : []),
      variants: children, sourceSyncInterrupted: Boolean(source?.lastFailureAt &&
        (!source.lastSuccessAt || source.lastFailureAt > source.lastSuccessAt)),
    } });
  });

  return router;
}

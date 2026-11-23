import { Router, json } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { schemeId } from '../catalogue/validation.js';
import { HttpError } from '../../middleware/http.js';
import { answersSchema, eligibilitySchema, questionsFor } from './criteria.js';
import { rankMatches } from './engine.js';

const idsSchema = z.array(schemeId.transform(id => id.toLowerCase())).min(1).max(50)
  .refine(ids => new Set(ids).size === ids.length);
const evaluateSchema = z.strictObject({ schemeIds: idsSchema, answers: answersSchema });
const questionQuery = z.strictObject({
  schemeIds: z.string().max(1249).transform(ids => ids.split(',')).pipe(idsSchema),
});
const bodyParser = json({ limit: '8kb', inflate: false });

function validated(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST', 'Check the scheme IDs and questionnaire inputs.');
  return result.data;
}

function readBody(req, res, next) {
  if (!req.is('application/json')) return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a JSON request.'));
  bodyParser(req, res, error => {
    if (!error) return next();
    if (error.status === 413) return next(new HttpError(413, 'BODY_TOO_LARGE', 'Questionnaire request is too large.'));
    if (error.status === 415) return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a supported JSON request.'));
    next(new HttpError(400, 'INVALID_REQUEST', 'Send a valid JSON questionnaire request.'));
  });
}

async function loadEntries({ Scheme, SchemeRuleVersion }, dataset, ids) {
  const schemes = await Scheme.find({
    _id: { $in: ids }, dataset, publicationStatus: 'published',
  }).select('verificationStatus currentVersionId sourceRefs').lean();
  const schemeById = new Map(schemes.map(scheme => [String(scheme._id), scheme]));
  const verified = schemes.filter(scheme => scheme.verificationStatus === 'verified' && scheme.currentVersionId);

  // Bind each rule set to the exact catalogue version that was selected.
  const records = verified.length ? await SchemeRuleVersion.find({
    schemeVersionId: { $in: verified.map(scheme => scheme.currentVersionId) },
  }).select('schemeId schemeVersionId rule').lean() : [];
  const rulesByScheme = new Map();
  for (const { schemeId, schemeVersionId, rule } of records) {
    const scheme = schemeById.get(String(schemeId));
    if (scheme?.verificationStatus !== 'verified' || String(scheme.currentVersionId) !== String(schemeVersionId)) continue;
    const parsed = eligibilitySchema.safeParse(rule);
    if (parsed.success && scheme.sourceRefs?.some(source => source.url === parsed.data.evidenceUrl)) {
      rulesByScheme.set(String(schemeId), parsed.data);
    }
  }

  return ids.filter(id => schemeById.has(id)).map(schemeId => ({ schemeId, rule: rulesByScheme.get(schemeId) }));
}

export function matchingRouter(models, dataset) {
  const router = Router();
  const evaluateLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many evaluations. Try again shortly.')),
  });

  router.get('/questions', async (req, res) => {
    const { schemeIds } = validated(questionQuery, req.query);
    const entries = await loadEntries(models, dataset, schemeIds);
    res.json({ dataset, questions: questionsFor(entries) });
  });

  router.post('/matches/evaluate', evaluateLimit, readBody, async (req, res) => {
    const { schemeIds, answers } = validated(evaluateSchema, req.body);
    const entries = await loadEntries(models, dataset, schemeIds);
    const allowed = new Set(questionsFor(entries).map(question => question.id));
    if (Object.keys(answers).some(key => !allowed.has(key))) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Only questions for the current schemes can be answered.');
    }

    res.json({ dataset, results: rankMatches(entries, answers) });
  });
  return router;
}

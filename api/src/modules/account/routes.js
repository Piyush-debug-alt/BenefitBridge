import { z } from 'zod';
import { HttpError } from '../../middleware/http.js';
import { jsonBody, safeInput } from '../auth/security.js';
import { listQuery, schemeId } from '../catalogue/validation.js';
import { answersSchema, questionDefinitions } from '../matching/criteria.js';

const bookmarkInput = z.strictObject({ schemeId });
const pageQuery = listQuery.pick({ page: true, limit: true });
const profileInput = z.strictObject({
  consent: z.literal(true),
  attributes: answersSchema.refine(values => Object.keys(values).length > 0),
});

function publicProfile(profile) {
  return profile && { attributes: profile.attributes, consentAt: profile.consentAt, updatedAt: profile.updatedAt };
}

export function mountAccountRoutes(router, { Profile, Bookmark, Scheme }, dataset, origin) {
  const published = { dataset, publicationStatus: 'published' };

  router.get('/me/profile', async (req, res) => {
    res.json({
      profile: publicProfile(await Profile.findOne({ userId: req.user._id }).lean()),
      questions: questionDefinitions(),
    });
  });
  router.put('/me/profile', origin, jsonBody, async (req, res) => {
    const { attributes } = safeInput(profileInput, req.body);
    const profile = await Profile.findOneAndUpdate({ userId: req.user._id }, {
      $set: { attributes, consentAt: new Date() },
    }, { upsert: true, new: true, runValidators: true }).lean();
    res.json({ profile: publicProfile(profile) });
  });
  router.delete('/me/profile', origin, async (req, res) => {
    await Profile.deleteOne({ userId: req.user._id });
    res.sendStatus(204);
  });

  router.get('/me/bookmarks', async (req, res) => {
    const { page, limit } = safeInput(pageQuery, req.query);
    const owner = { userId: req.user._id };
    const [items, total] = await Promise.all([
      Bookmark.find(owner).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Bookmark.countDocuments(owner),
    ]);
    const schemes = await Scheme.find({ ...published, _id: { $in: items.map(item => item.schemeId) } })
      .select('canonicalName').lean();
    const names = new Map(schemes.map(item => [String(item._id), item.canonicalName]));
    res.json({
      items: items.map(item => ({ schemeId: String(item.schemeId), name: names.get(String(item.schemeId)) ?? null })),
      totalPages: Math.min(1000, Math.ceil(total / limit)),
    });
  });
  router.get('/me/bookmarks/:schemeId', async (req, res) => {
    const id = safeInput(schemeId, req.params.schemeId);
    const saved = await Bookmark.exists({ userId: req.user._id, schemeId: id });
    res.json({ bookmarked: Boolean(saved) });
  });
  router.post('/me/bookmarks', origin, jsonBody, async (req, res) => {
    const { schemeId } = safeInput(bookmarkInput, req.body);
    if (!await Scheme.exists({ ...published, _id: schemeId })) {
      throw new HttpError(404, 'SCHEME_NOT_FOUND', 'This scheme could not be found.');
    }
    await Bookmark.updateOne({ userId: req.user._id, schemeId }, { $setOnInsert: { createdAt: new Date() } }, {
      upsert: true, timestamps: false,
    });
    res.json({ bookmarked: true });
  });
  router.delete('/me/bookmarks/:schemeId', origin, async (req, res) => {
    const id = safeInput(schemeId, req.params.schemeId);
    await Bookmark.deleteOne({ userId: req.user._id, schemeId: id });
    res.sendStatus(204);
  });
}

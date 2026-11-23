export async function queuePublication(ChangeEvent, dataset, schemeId, version) {
  const now = new Date();
  await ChangeEvent.updateOne({ schemeId, versionId: version._id }, {
    $setOnInsert: {
      dataset, versionNo: version.versionNo, type: version.versionNo === 1 ? 'profile_match' : 'bookmark_update',
      availableAt: now, createdAt: now,
    },
  }, { upsert: true, runValidators: true });
}

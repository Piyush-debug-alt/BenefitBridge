export async function queuePublication(ChangeEvent, dataset, schemeId, version, type = version.versionNo === 1 ? 'profile_match' : 'bookmark_update') {
  const now = new Date();
  await ChangeEvent.updateOne({ schemeId, versionId: version._id }, {
    $setOnInsert: {
      dataset, versionNo: version.versionNo, type,
      availableAt: now, createdAt: now,
    },
  }, { upsert: true, runValidators: true });
}

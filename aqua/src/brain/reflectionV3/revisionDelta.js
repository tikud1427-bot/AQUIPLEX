/**
 * AQUA Brain — E9 / PR-7 named revision delta v2.
 *
 * Counts are secondary metadata. The primary human-readable payload is a small
 * set of named subjects and at most two before→after changes, exactly so the
 * revision voice can ask a person about the subject rather than reciting an
 * arithmetic changelog.
 */

const MAX_SUBJECTS = 5;
const MAX_CHANGES = 2;
const clean = value => String(value ?? '').trim();

function subjectOf(item) {
  return clean(item?.subject ?? item?.label ?? item?.title ?? item?.canonicalLabel ?? item?.predicate);
}

function changeOf(item) {
  const subject = subjectOf(item);
  const from = clean(item?.from ?? item?.before ?? item?.previous ?? '');
  const to = clean(item?.to ?? item?.after ?? item?.current ?? '');
  if (!subject || (!from && !to)) return null;
  return { subject, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(item?.reason ? { reason: clean(item.reason) } : {}) };
}

function unique(list) {
  return [...new Set(list.map(clean).filter(Boolean))];
}

export function buildRevisionDeltaV2({
  ownerId,
  entitiesChanged = [],
  relationshipsChanged = [],
  goalsChanged = [],
  beliefsChanged = [],
  assumptionsRevised = [],
  obsoleted = [],
} = {}) {
  const subjectCandidates = [
    ...entitiesChanged.map(subjectOf),
    ...relationshipsChanged.map(subjectOf),
    ...goalsChanged.map(subjectOf),
    ...beliefsChanged.map(subjectOf),
    ...assumptionsRevised.map(subjectOf),
    ...obsoleted.map(x => clean(x?.subject ?? x?.factId)),
  ];
  const subjects = unique(subjectCandidates).slice(0, MAX_SUBJECTS);
  const revisions = assumptionsRevised.map(changeOf).filter(Boolean).slice(0, MAX_CHANGES);

  const entities = { added: 0, changed: 0 };
  for (const item of entitiesChanged) {
    if (item?.change === 'added') entities.added += 1;
    else entities.changed += 1;
  }
  const relationships = { added: 0, changed: relationshipsChanged.length };

  return {
    version: 2,
    ownerId: ownerId ?? null,
    subjects,
    revisions,
    entities,
    relationships,
    goalsChanged: goalsChanged.slice(0, 8),
    beliefsChanged: beliefsChanged.slice(0, 8),
    obsoleted: obsoleted.slice(0, 8),
    worldModelUpdated: subjects.length > 0 || revisions.length > 0 || obsoleted.length > 0,
  };
}

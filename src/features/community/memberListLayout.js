export const MEMBER_HEADER_HEIGHT = 56;
export const MEMBER_ROW_HEIGHT = 40;
export const MEMBER_OVERSCAN = 160;

export function buildMemberListRows(groups, voicePeople) {
  const rows = [];
  if (voicePeople.length) {
    rows.push({ type: 'heading', key: 'voice-heading', height: MEMBER_HEADER_HEIGHT, label: `Voice — ${voicePeople.length}` });
    voicePeople.forEach(user => rows.push({ type: 'voice', key: `voice-${user.id}`, height: MEMBER_ROW_HEIGHT, user }));
    rows.push({ type: 'spacer', key: 'voice-spacer', height: 10 });
  }
  groups.forEach(group => {
    rows.push({ type: 'heading', key: `role-${group.role.id}`, height: MEMBER_HEADER_HEIGHT, label: `${group.role.name} — ${group.totalCount}`, color: group.role.color });
    group.members.forEach(member => rows.push({ type: 'member', key: `member-${member.id}`, height: MEMBER_ROW_HEIGHT, member }));
    rows.push({ type: 'spacer', key: `role-spacer-${group.role.id}`, height: 10 });
  });
  let top = 0;
  return rows.map(row => {
    const positioned = { ...row, top };
    top += row.height;
    return positioned;
  });
}

export function firstMemberRowAtOrAfter(rows, top) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top + rows[middle].height < top) low = middle + 1;
    else high = middle;
  }
  return low;
}

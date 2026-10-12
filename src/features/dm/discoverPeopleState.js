export function mergePeoplePages(current, incoming) {
  const rows = new Map(current.map(person => [Number(person.id), person]));
  for (const person of incoming) rows.set(Number(person.id), person);
  return [...rows.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

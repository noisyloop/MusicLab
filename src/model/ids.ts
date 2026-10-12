let counter = 0;

/** Short random id. Unique enough for a single project; not a security token. */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

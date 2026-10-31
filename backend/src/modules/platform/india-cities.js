import { readFileSync } from 'node:fs';

// Lowercase, without accents or punctuation, so "Thāne" finds Thane and "navi-mumbai" Navi Mumbai.
export const searchKey = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let loaded;

// Every Indian city and town (GeoNames, built by scripts/build-india-cities.js), largest first.
// Rows are [slug, name, state, population, aliases?].
function load() {
  if (loaded) return loaded;
  const rows = JSON.parse(readFileSync(new URL('./india-cities.json', import.meta.url), 'utf8'));
  const places = rows.map(([slug, name, region, population, aliases = []]) => {
    const names = [name, ...aliases];
    return { slug, name, region, population, names, keys: names.map(searchKey) };
  });
  const bySlug = new Map(places.map((p) => [p.slug, p]));
  // A name shared by several places finds the largest; aliases never repeat another place's name.
  const byKey = new Map();
  for (const p of places) for (const key of p.keys) if (!byKey.has(key)) byKey.set(key, p);
  loaded = { places, bySlug, byKey };
  return loaded;
}

export const indianCities = () => load().places;

// A place by its slug from the search, its name or another name for it ("Bangalore").
export function findIndianCity(text) {
  const { bySlug, byKey } = load();
  return bySlug.get(text.trim().toLowerCase()) ?? byKey.get(searchKey(text)) ?? null;
}

// How well the search key `q` matches the first of `keys` (the name) or the others (aliases), as a
// `tier`: 0 the whole name, 1 its start, 2 the start of a later word, 3 anywhere (only for 3 or more
// letters, or "pu" would list every -pur town). The name wins over an alias in the same tier.
// `index` is the key that matched. null when nothing matches.
export function bestMatch(keys, q) {
  let best = null;
  const word = ` ${q}`;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const tier = key === q ? 0 : key.startsWith(q) ? 1 : key.includes(word) ? 2 : q.length >= 3 && key.includes(q) ? 3 : null;
    if (tier !== null && (!best || tier < best.tier)) best = { tier, index };
  }
  return best;
}

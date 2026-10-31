// Builds src/modules/platform/india-cities.json, the list of Indian cities and towns the city search
// (GET /config/cities?q=) and registration take. Source: GeoNames (https://www.geonames.org),
// CC BY 4.0, which asks for credit to GeoNames wherever the data is shown or shipped.
//   1. Download https://download.geonames.org/export/dump/cities1000.zip and unzip it, and
//      https://download.geonames.org/export/dump/admin1CodesASCII.txt (the state names).
//   2. node scripts/build-india-cities.js <path to cities1000.txt> <path to admin1CodesASCII.txt>
import { readFileSync, writeFileSync } from 'node:fs';
import { searchKey } from '../src/modules/platform/india-cities.js';

const [citiesPath, statesPath] = process.argv.slice(2);
if (!citiesPath || !statesPath) {
  console.error('Usage: node scripts/build-india-cities.js <cities1000.txt> <admin1CodesASCII.txt>');
  process.exit(1);
}

const rows = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));

const states = new Map(rows(statesPath).filter(([code]) => code.startsWith('IN.')).map(([code, name]) => [code.slice(3), name]));

// Cities, towns and villages. Sections of a city (PPLX: Rohini, Dharavi), localities (PPLL) and
// abandoned, historical or religious places are left out.
const SETTLEMENTS = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG']);

const places = rows(citiesPath)
  .filter((r) => r[8] === 'IN' && SETTLEMENTS.has(r[7]) && states.has(r[10]))
  .map((r) => ({ name: r[2], state: states.get(r[10]), population: Number(r[14]) || 0, alternateNames: r[3] ? r[3].split(',') : [] }))
  .sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));

// Two places with the same name in one state are the same entry to a user picking a home city:
// the larger one is kept.
const seen = new Set();
const unique = places.filter((p) => {
  const key = `${searchKey(p.name)}|${p.state}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const names = new Set(unique.map((p) => searchKey(p.name)));
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Other names people type for a city: Bangalore, Bombay, Calcutta, Gurgaon. GeoNames lists
// spellings in every language; only Latin-script proper names are kept (no airport codes or
// lowercase transliterations), and none that is another place's name.
function aliasesOf(place) {
  const own = searchKey(place.name);
  const kept = new Map();
  for (const raw of place.alternateNames) {
    const alias = ascii(raw).trim();
    const key = searchKey(alias);
    if (!/^[A-Z][a-z]+(?:[ '-][A-Za-z][a-z]*)*$/.test(alias) || key === own || names.has(key) || kept.has(key)) continue;
    kept.set(key, alias);
  }
  return [...kept.values()];
}

// The largest place of a name gets the plain slug (aurangabad); the others add their state (aurangabad-bihar).
const slugOf = (s) => searchKey(s).replaceAll(' ', '-');
const taken = new Set();
const entries = unique.map((p) => {
  let slug = slugOf(p.name);
  if (taken.has(slug)) slug = `${slug}-${slugOf(p.state)}`;
  taken.add(slug);
  const aliases = aliasesOf(p);
  return [slug, p.name, p.state, p.population, ...(aliases.length ? [aliases] : [])];
});

const out = new URL('../src/modules/platform/india-cities.json', import.meta.url);
writeFileSync(out, `[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`);
console.info(`Wrote ${entries.length} places (${places.length - unique.length} same-name duplicates left out)`);

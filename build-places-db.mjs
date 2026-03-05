// scripts/build-places-db.mjs
// Genereert data/places-db.v1.json (5 plekken per land) via Wikidata.
// Run: node scripts/build-places-db.mjs
import fs from "node:fs/promises";

const WORLD_ATLAS_TOPOJSON = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const WDQS = "https://query.wikidata.org/sparql";

// Plaatstypen (stad / dorp / toeristische attractie / nationaal park / enz.)
const PRIMARY_PLACE_TYPES = ["Q9259","Q46169","Q570116","Q473972","Q8502","Q34038","Q40080"];

function padIsoNum(n){
  const digits = String(n ?? "").replace(/[^\d]/g,"");
  return digits ? digits.padStart(3,"0") : "";
}
function qidFromUri(uri){ return (/\/(Q\d+)$/.exec(uri||"")||[])[1] || ""; }
function parseWktPoint(wkt){
  const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(wkt||"");
  if(!m) return null;
  const lon = Number(m[1]), lat = Number(m[2]);
  return Number.isFinite(lat)&&Number.isFinite(lon) ? {lat, lon} : null;
}
function commonsImageUrl(fileUriOrName, width=560){
  const u = String(fileUriOrName||"");
  if(!u) return "";
  if (u.includes("Special:FilePath/")) return u + `?width=${encodeURIComponent(width)}`;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(u)}?width=${encodeURIComponent(width)}`;
}

async function wdqsQuery(query, tries=5){
  let wait = 450;
  for (let i=0;i<tries;i++){
    const res = await fetch(WDQS, {
      method: "POST",
      headers: {
        "Accept": "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "WereldExplorer/1.0 (school project)"
      },
      body: new URLSearchParams({ query })
    });

    if (res.ok) return res.json();

    if ([429,500,502,503,504].includes(res.status) && i < tries-1) {
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(4000, wait * 1.8);
      continue;
    }
    const txt = await res.text().catch(()=> "");
    throw new Error(`WDQS ${res.status}: ${txt.slice(0,200)}`);
  }
  throw new Error("WDQS retries exhausted");
}

async function getCountryQidAndMeta(isoNum){
  const sparql = `
    SELECT ?country ?capitalLabel ?continentLabel ?population ?flag WHERE {
      ?country wdt:P299 "${isoNum}" .
      OPTIONAL { ?country wdt:P36 ?capital . }
      OPTIONAL { ?country wdt:P30 ?continent . }
      OPTIONAL { ?country wdt:P1082 ?population . }
      OPTIONAL { ?country wdt:P41 ?flag . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". }
    } LIMIT 1
  `;
  const data = await wdqsQuery(sparql);
  const b = data?.results?.bindings?.[0] || {};
  const countryQid = qidFromUri(b.country?.value || "");
  return {
    countryQid,
    meta: {
      capital: b.capitalLabel?.value || "—",
      continent: b.continentLabel?.value || "—",
      population: b.population?.value || "",
      flag: b.flag?.value || ""
    }
  };
}

async function queryPlaces(countryQid, {types=[], limit=160, minSitelinks=0, includeP131=false} = {}){
  const typeBlock = types.length
    ? `VALUES ?t { ${types.map(q => `wd:${q}`).join(" ")} } ?place wdt:P31/wdt:P279* ?t .`
    : "";
  const sitelinkFilter = minSitelinks > 0 ? `FILTER(COALESCE(?sitelinks, 0) >= ${minSitelinks})` : "";
  const locationBlock = includeP131
    ? `{ ?place wdt:P17 ?country . } UNION { ?place wdt:P131* ?country . }`
    : `?place wdt:P17 ?country .`;

  const sparql = `
    SELECT ?place ?placeLabel ?placeDescription ?coord ?image ?sitelinks WHERE {
      BIND(wd:${countryQid} AS ?country)
      ?place wdt:P625 ?coord .
      ${locationBlock}
      ${typeBlock}
      FILTER NOT EXISTS { ?place wdt:P31 wd:Q4167836 }
      FILTER NOT EXISTS { ?place wdt:P31 wd:Q13406463 }
      OPTIONAL { ?place wdt:P18 ?image . }
      OPTIONAL { ?place wikibase:sitelinks ?sitelinks . }
      ${sitelinkFilter}
      SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". }
    }
    ORDER BY DESC(COALESCE(?sitelinks, 0))
    LIMIT ${limit}
  `;

  const data = await wdqsQuery(sparql);
  const rows = data?.results?.bindings || [];
  const out = [];
  const seen = new Set();

  for (const r of rows){
    const uri = r.place?.value || "";
    const qid = qidFromUri(uri);
    if(!qid || seen.has(qid)) continue;

    const p = parseWktPoint(r.coord?.value);
    if(!p) continue;

    seen.add(qid);
    out.push({
      qid,
      label: r.placeLabel?.value || qid,
      desc: r.placeDescription?.value || "",
      lat: p.lat,
      lng: p.lon,
      image: r.image?.value ? commonsImageUrl(r.image.value, 560) : "",
      sitelinks: r.sitelinks?.value ? Number(r.sitelinks.value) : 0,
      wikidataUrl: uri
    });
  }
  return out;
}

async function main(){
  const world = await (await fetch(WORLD_ATLAS_TOPOJSON)).json();
  const geoms = world?.objects?.countries?.geometries || [];
  const isos = geoms.map(g => padIsoNum(g.id)).filter(Boolean);

  const db = { version: 1, generatedAt: new Date().toISOString(), byIso: {} };

  for (let i=0; i<isos.length; i++){
    const iso = isos[i];
    try{
      const { countryQid, meta } = await getCountryQidAndMeta(iso);
      if(!countryQid){
        console.log(`SKIP ${iso} (geen land)`);
        continue;
      }

      let places = await queryPlaces(countryQid, { types: PRIMARY_PLACE_TYPES, minSitelinks: 2, limit: 180, includeP131:false });

      if (places.length < 5) {
        const more = await queryPlaces(countryQid, { types: [], minSitelinks: 10, limit: 260, includeP131:false });
        const s = new Set(places.map(p=>p.qid));
        for (const p of more) if(!s.has(p.qid)) { places.push(p); s.add(p.qid); }
      }

      if (places.length < 5) {
        const heavy = await queryPlaces(countryQid, { types: [], minSitelinks: 0, limit: 320, includeP131:true });
        const s = new Set(places.map(p=>p.qid));
        for (const p of heavy) if(!s.has(p.qid)) { places.push(p); s.add(p.qid); }
      }

      db.byIso[iso] = { countryQid, meta, places: places.slice(0, 5) };
      console.log(`OK ${iso} (${i+1}/${isos.length}) -> 5`);
      await new Promise(r => setTimeout(r, 240));
    } catch(e){
      console.warn(`FAIL ${iso}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/places-db.v1.json", JSON.stringify(db, null, 2), "utf8");
  console.log("Saved: data/places-db.v1.json");
}

main().catch(e => { console.error(e); process.exit(1); });

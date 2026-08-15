// Shared Amadeus plumbing used by the flight, hotel, and activities providers:
// OAuth2 token caching, authenticated GET, location (name -> code + geo) lookup,
// and small geo/duration helpers.

const BASE = process.env.AMADEUS_BASE_URL || "https://test.api.amadeus.com";
const TIMEOUT_MS = Number(process.env.AMADEUS_TIMEOUT_MS || 15000);

export function amadeusConfigured() {
  return Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
}

export function amadeusEnabled() {
  return amadeusConfigured() && process.env.AMADEUS_DISABLE !== "1";
}

// --- token cache ------------------------------------------------------------
let _token = { value: null, expiresAt: 0 };

export async function getToken() {
  const now = Date.now();
  if (_token.value && now < _token.expiresAt - 30_000) return _token.value;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET,
  });
  const res = await fetch(`${BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Amadeus auth failed (${res.status}): ${json.error_description || json.error || res.statusText}`);
  }
  _token = { value: json.access_token, expiresAt: now + (json.expires_in || 1799) * 1000 };
  return _token.value;
}

export async function amadeusGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(json.errors) ? json.errors.map((e) => e.detail || e.title).join("; ") : res.statusText;
    throw new Error(`Amadeus ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

// --- location resolution (name/code -> IATA code + geo), cached -------------
const _locCache = new Map();

// Returns { code, latitude, longitude, name }. Accepts a city name or a 3-letter
// IATA code. Always attempts the lookup so we also get the geo-coordinates that
// the activities/hotel-by-geocode calls need.
export async function resolveLocation(place) {
  const raw = String(place || "").trim();
  if (!raw) throw new Error("Amadeus: empty location");
  const key = raw.toLowerCase();
  if (_locCache.has(key)) return _locCache.get(key);

  const json = await amadeusGet("/v1/reference-data/locations", {
    subType: "CITY,AIRPORT",
    keyword: raw,
    "page[limit]": 5,
    view: "LIGHT",
  });
  const data = json.data || [];
  const isCode = /^[A-Z]{3}$/.test(raw);
  const chosen =
    (isCode && data.find((d) => d.iataCode === raw)) ||
    data.find((d) => d.subType === "CITY") ||
    data[0];
  if (!chosen || !chosen.iataCode) {
    throw new Error(`Amadeus: could not resolve "${raw}" to a location`);
  }
  const geo = chosen.geoCode || {};
  const resolved = {
    code: chosen.iataCode,
    latitude: geo.latitude ?? null,
    longitude: geo.longitude ?? null,
    name: chosen.name || raw,
  };
  _locCache.set(key, resolved);
  return resolved;
}

export async function resolveLocationCode(place) {
  return (await resolveLocation(place)).code;
}

// --- geo + duration helpers -------------------------------------------------
export function haversineKm(a, b) {
  if (a?.lat == null || a?.lon == null || b?.lat == null || b?.lon == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return +(2 * R * Math.asin(Math.sqrt(s))).toFixed(2);
}

// "PT14H30M" -> { minutes, label:"14h 30m" }
export function parseIsoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || "");
  const h = m ? Number(m[1] || 0) : 0;
  const min = m ? Number(m[2] || 0) : 0;
  return { minutes: h * 60 + min, label: `${h}h${min ? ` ${min}m` : ""}` };
}

export function titleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export { BASE, TIMEOUT_MS };

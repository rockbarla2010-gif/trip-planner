// Google Places API (New) provider for the Food Agent.
//
// Uses Text Search (places:searchText). When the day's attraction-cluster
// centroid is known it biases results to that location (real proximity); with no
// coordinates it falls back to a "<terms> restaurants in <place>" text query.
// Returns the SAME shape as the stub searchRestaurants.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = Number(process.env.GOOGLE_TIMEOUT_MS || 12000);
const RADIUS_M = Number(process.env.GOOGLE_PLACES_RADIUS_M || 1500);

function apiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "";
}
export function googlePlacesEnabled() {
  return Boolean(apiKey()) && process.env.GOOGLE_DISABLE !== "1";
}

const FIELD_MASK = [
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.formattedAddress",
  "places.location",
  "places.googleMapsUri",
  "places.editorialSummary",
].join(",");

const PRICE_MAP = {
  PRICE_LEVEL_FREE: "$",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$",
};

function cuisineFrom(place) {
  const t = place.primaryTypeDisplayName?.text;
  if (t) return t.replace(/\brestaurant\b/i, "").trim() || "Restaurant";
  // derive from a cuisine-specific type like "italian_restaurant"
  const typed = (place.types || []).find((x) => x.endsWith("_restaurant") && x !== "restaurant");
  if (typed) return titleCase(typed.replace(/_restaurant$/, "").replace(/_/g, " "));
  return "Restaurant";
}
function titleCase(s) {
  return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
}

// Honest dietary check: only "satisfied" if the place is explicitly typed for it.
function dietaryConflicts(place, restrictions) {
  const types = place.types || [];
  const name = `${place.displayName?.text || ""} ${place.primaryTypeDisplayName?.text || ""}`.toLowerCase();
  const out = [];
  for (const d of restrictions) {
    const dd = String(d).toLowerCase();
    let ok = false;
    if (dd.includes("vegan")) ok = types.includes("vegan_restaurant") || name.includes("vegan");
    else if (dd.includes("vegetarian")) ok = types.includes("vegetarian_restaurant") || types.includes("vegan_restaurant") || name.includes("veg");
    else ok = name.includes(dd);
    if (!ok) out.push(`No confirmed "${d}" option`);
  }
  return out;
}

export async function searchRestaurantsGoogle({
  destination,
  cuisine = [],
  dietary_restrictions = [],
  budget_level = "$$",
  area = null,
  lat = null,
  lon = null,
  max = 6,
}) {
  const terms = [...dietary_restrictions, ...cuisine].filter(Boolean).join(" ");
  const hasGeo = lat != null && lon != null;
  const textQuery = hasGeo
    ? `${terms} restaurants`.trim()
    : `${terms} restaurants in ${area || destination}`.trim();

  const body = {
    textQuery,
    includedType: "restaurant",
    maxResultCount: max,
  };
  if (hasGeo) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: RADIUS_M } };
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message || res.statusText;
    throw new Error(`Google Places failed (${res.status}): ${msg}`);
  }

  const places = json.places || [];
  if (!places.length) throw new Error(`Google Places: no restaurants for "${textQuery}"`);

  const options = places.slice(0, max).map((p) => {
    const cuisineLabel = cuisineFrom(p);
    const price_range = PRICE_MAP[p.priceLevel] || "$$";
    const rating = p.rating != null ? Number(p.rating) : null;
    const count = p.userRatingCount != null ? Number(p.userRatingCount) : null;
    return {
      name: p.displayName?.text || "Restaurant",
      cuisine: cuisineLabel,
      price_range,
      cluster: area,
      rating,
      rating_count: count,
      address: p.formattedAddress || null,
      maps_uri: p.googleMapsUri || null,
      tags: p.types || [],
      dietary_conflict: dietaryConflicts(p, dietary_restrictions),
      why:
        `${cuisineLabel}${area ? ` near ${area}` : ""}` +
        (rating != null ? `, ${rating}★${count ? ` (${count})` : ""}` : "") +
        `, ${price_range}`,
    };
  });

  return {
    data_source: "google",
    is_placeholder: false,
    query: { destination, cuisine, dietary_restrictions, area, lat, lon },
    options,
  };
}

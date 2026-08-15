// Stub data sources behind a clean interface. Swap the bodies of these functions
// for real APIs (Amadeus, Booking.com, Google Places) later WITHOUT touching any
// agent logic — the shape of the return values is the contract.
//
// Everything here is deterministic (seeded by the query) so tests and the demo
// produce stable output, and every record is tagged `data_source: "stub"` so the
// agents can honestly tell the user the numbers are estimates, not live quotes.

import { amadeusEnabled } from "./integrations/amadeusCore.js";
import { searchFlightsAmadeus } from "./integrations/amadeus.js";
import { searchHotelsAmadeus } from "./integrations/amadeusHotels.js";
import { searchAttractionsAmadeus } from "./integrations/amadeusActivities.js";
import { googlePlacesEnabled, searchRestaurantsGoogle } from "./integrations/googlePlaces.js";

const IS_STUB = true;

// Generic provider wrapper: when a real provider is enabled, try it and on any
// error fall back to the stub with the error attached (never a silent fake).
// Set <FALLBACK_ENV>=0 to surface the error and return no results instead.
async function withProvider({ enabled, real, stub, query, empty, sourceTag, errorKey, fallbackEnv }) {
  if (enabled) {
    try {
      return await real(query);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (process.env[fallbackEnv] === "0") {
        return { ...empty, data_source: sourceTag, is_placeholder: false, error: msg, query };
      }
      return { ...stub(query), [errorKey]: msg, data_source: "stub-fallback" };
    }
  }
  return stub(query);
}

// --- tiny seeded PRNG so "estimates" are stable per query -------------------
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFor(...parts) {
  return mulberry32(seedFrom(parts.join("|")));
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function money(rng, min, max) {
  return Math.round((min + rng() * (max - min)) / 5) * 5;
}

// --- a small curated "catalog" for well-known cities, generic fallback else --
const CATALOG = {
  "tokyo": {
    airlines: ["ANA", "Japan Airlines", "United"],
    clusters: ["Shinjuku", "Asakusa", "Shibuya", "Ueno"],
    attractions: [
      { name: "Senso-ji Temple", category: "Culture", cluster: "Asakusa", hours: "6:00-17:00", time_needed_hrs: 2, booking: "None" },
      { name: "Meiji Shrine", category: "Culture", cluster: "Shibuya", hours: "Sunrise-Sunset", time_needed_hrs: 1.5, booking: "None" },
      { name: "teamLab Planets", category: "Art/Immersive", cluster: "Shibuya", hours: "9:00-22:00", time_needed_hrs: 2, booking: "Timed entry, advance tickets" },
      { name: "Tsukiji Outer Market", category: "Food/Market", cluster: "Shinjuku", hours: "5:00-14:00", time_needed_hrs: 2, booking: "None" },
      { name: "Ueno Park & Museums", category: "Culture/Parks", cluster: "Ueno", hours: "9:00-17:00", time_needed_hrs: 3, booking: "Some museums ticketed" },
      { name: "Shibuya Crossing & Sky", category: "Landmark", cluster: "Shibuya", hours: "9:00-23:00", time_needed_hrs: 1.5, booking: "Sky deck advance ticket" },
    ],
    restaurants: [
      { name: "Ichiran Ramen", cuisine: "Ramen", price_range: "$", cluster: "Shibuya", tags: ["vegetarian-option-limited"] },
      { name: "Sushi Dai", cuisine: "Sushi", price_range: "$$", cluster: "Shinjuku", tags: [] },
      { name: "Ain Soph Journey", cuisine: "Vegan Japanese", price_range: "$$", cluster: "Shibuya", tags: ["vegan", "vegetarian"] },
      { name: "Asakusa Imahan", cuisine: "Sukiyaki", price_range: "$$$", cluster: "Asakusa", tags: [] },
    ],
  },
  "paris": {
    airlines: ["Air France", "Delta", "Lufthansa"],
    clusters: ["Le Marais", "Latin Quarter", "Montmartre", "Champs-Élysées"],
    attractions: [
      { name: "Louvre Museum", category: "Museum", cluster: "Le Marais", hours: "9:00-18:00 (closed Tue)", time_needed_hrs: 3, booking: "Timed entry, advance tickets" },
      { name: "Eiffel Tower", category: "Landmark", cluster: "Champs-Élysées", hours: "9:30-23:45", time_needed_hrs: 2, booking: "Advance tickets strongly advised" },
      { name: "Musée d'Orsay", category: "Museum", cluster: "Latin Quarter", hours: "9:30-18:00 (closed Mon)", time_needed_hrs: 2.5, booking: "Advance tickets" },
      { name: "Sacré-Cœur & Montmartre", category: "Culture/Views", cluster: "Montmartre", hours: "6:00-22:30", time_needed_hrs: 2.5, booking: "None" },
      { name: "Notre-Dame & Île de la Cité", category: "Culture", cluster: "Latin Quarter", hours: "8:00-19:00", time_needed_hrs: 1.5, booking: "None" },
      { name: "Le Marais Walking Loop", category: "Neighborhood", cluster: "Le Marais", hours: "Anytime", time_needed_hrs: 2, booking: "None" },
    ],
    restaurants: [
      { name: "Chez Janou", cuisine: "Provençal", price_range: "$$", cluster: "Le Marais", tags: [] },
      { name: "Le Potager du Marais", cuisine: "Vegan French", price_range: "$$", cluster: "Le Marais", tags: ["vegan", "vegetarian", "gluten-free-option"] },
      { name: "Bouillon Pigalle", cuisine: "Classic French", price_range: "$", cluster: "Montmartre", tags: [] },
      { name: "Les Papilles", cuisine: "Bistro", price_range: "$$$", cluster: "Latin Quarter", tags: [] },
    ],
  },
};

const GENERIC_CLUSTERS = ["Old Town", "Downtown", "Waterfront", "Museum District"];
const GENERIC_AIRLINES = ["SkyLink", "Global Air", "TransContinental"];

function catalogFor(destination) {
  const key = String(destination || "").trim().toLowerCase();
  if (CATALOG[key]) return { key, ...CATALOG[key] };
  // Deterministic generic catalog for any other destination.
  const rng = rngFor("catalog", key);
  const clusters = GENERIC_CLUSTERS;
  const cats = ["Landmark", "Museum", "Park", "Market", "Viewpoint", "Neighborhood"];
  const attractions = Array.from({ length: 6 }, (_, i) => ({
    name: `${destination} ${cats[i % cats.length]} #${i + 1}`,
    category: cats[i % cats.length],
    cluster: clusters[i % clusters.length],
    hours: pick(rng, ["9:00-17:00", "10:00-18:00", "8:00-20:00"]),
    time_needed_hrs: pick(rng, [1.5, 2, 2.5, 3]),
    booking: pick(rng, ["None", "Advance tickets", "Timed entry"]),
  }));
  const restaurants = Array.from({ length: 4 }, (_, i) => ({
    name: `${destination} Eatery ${i + 1}`,
    cuisine: pick(rng, ["Local", "International", "Seafood", "Vegetarian"]),
    price_range: pick(rng, ["$", "$$", "$$$"]),
    cluster: clusters[i % clusters.length],
    tags: i % 2 === 0 ? ["vegetarian"] : [],
  }));
  return { key, airlines: GENERIC_AIRLINES, clusters, attractions, restaurants };
}

// ---------------------------------------------------------------------------
// Public interface — the four functions the sub-agents call.
// ---------------------------------------------------------------------------

const AMADEUS = (real, stub, empty) => ({
  enabled: amadeusEnabled(),
  real,
  stub,
  empty,
  sourceTag: "amadeus",
  errorKey: "amadeus_error",
  fallbackEnv: "AMADEUS_FALLBACK",
});

// Uses the real Amadeus API when credentials are set, otherwise the stub.
export async function searchFlights(query) {
  return withProvider({
    ...AMADEUS(
      (q) => searchFlightsAmadeus({ ...q, currency: q.currency || q.budget_currency || "USD" }),
      searchFlightsStub,
      { options: [] }
    ),
    query,
  });
}

function searchFlightsStub({ origin, destination, start_date, end_date, traveler_count = 1, budget_ceiling = null }) {
  const cat = catalogFor(destination);
  const rng = rngFor("flights", origin, destination, start_date);
  const options = cat.airlines.slice(0, 3).map((airline, i) => {
    const layovers = i; // 0, 1, 2
    const base = money(rng, 380, 1200) + layovers * -40 + i * 30;
    const price_per_person = Math.max(180, base);
    const hours = 6 + layovers * 3 + Math.round(rng() * 4);
    return {
      airline,
      price_per_person,
      currency: "USD",
      price_total: price_per_person * traveler_count,
      layovers,
      total_travel_time: `${hours}h${layovers ? ` (${layovers} stop${layovers > 1 ? "s" : ""})` : " nonstop"}`,
      transit_warnings:
        layovers > 0
          ? ["Check transit-visa rules for layover country if outside home region."]
          : [],
    };
  });
  options.sort((a, b) => a.price_per_person - b.price_per_person);
  return {
    data_source: "stub",
    is_placeholder: IS_STUB,
    query: { origin, destination, start_date, end_date, traveler_count, budget_ceiling },
    options,
  };
}

export async function searchHotels(query) {
  return withProvider({
    ...AMADEUS(
      (q) => searchHotelsAmadeus({ ...q, currency: q.currency || q.budget_currency || "USD" }),
      searchHotelsStub,
      { options: [], recommended_index: 0 }
    ),
    query,
  });
}

function searchHotelsStub({ destination, start_date, end_date, traveler_count = 1, budget = null, near_clusters = [] }) {
  const cat = catalogFor(destination);
  const rng = rngFor("hotels", destination, start_date);
  const targetCluster = near_clusters[0] || cat.clusters[0];
  const options = [0, 1, 2].map((i) => {
    // First option is placed in the target cluster (proximity-optimized),
    // the others progressively cheaper but farther out.
    const area = i === 0 ? targetCluster : cat.clusters[(cat.clusters.indexOf(targetCluster) + i) % cat.clusters.length];
    const price_per_night = money(rng, 90, 380) - i * 25;
    const distance_km = i === 0 ? +(0.3 + rng() * 0.9).toFixed(1) : +(1.5 + i * 1.8 + rng()).toFixed(1);
    return {
      name: `${area} ${pick(rng, ["Grand", "Central", "Boutique", "Garden"])} Hotel`,
      price_per_night: Math.max(60, price_per_night),
      currency: "USD",
      area,
      distance_to_clusters_km: distance_km,
      near_cluster: area,
      rating: +(4.6 - i * 0.4).toFixed(1),
    };
  });
  return {
    data_source: "stub",
    is_placeholder: IS_STUB,
    query: { destination, start_date, end_date, traveler_count, budget, near_clusters },
    options,
  };
}

export async function searchAttractions(query) {
  return withProvider({
    ...AMADEUS(searchAttractionsAmadeus, searchAttractionsStub, {
      attractions: [],
      clusters: [],
      cluster_centroids: [],
    }),
    query,
  });
}

function searchAttractionsStub({ destination, interests = [], trip_days = 3 }) {
  const cat = catalogFor(destination);
  const wanted = Math.max(2, Math.min(cat.attractions.length, Math.round(trip_days * 2.5)));
  // Bias toward matching interests (by category substring) but keep variety.
  const scored = cat.attractions
    .map((a) => {
      const match = interests.some((it) =>
        `${a.category} ${a.name}`.toLowerCase().includes(String(it).toLowerCase())
      );
      return { a, score: match ? 1 : 0 };
    })
    .sort((x, y) => y.score - x.score);
  const shortlist = scored.slice(0, wanted).map(({ a }) => ({ ...a }));
  return {
    data_source: "stub",
    is_placeholder: IS_STUB,
    query: { destination, interests, trip_days },
    clusters: [...new Set(shortlist.map((a) => a.cluster))],
    attractions: shortlist,
  };
}

// Uses the real Google Places API when a key is set, otherwise the stub.
export async function searchRestaurants(query) {
  return withProvider({
    enabled: googlePlacesEnabled(),
    real: searchRestaurantsGoogle,
    stub: searchRestaurantsStub,
    empty: { options: [] },
    sourceTag: "google",
    errorKey: "google_error",
    fallbackEnv: "GOOGLE_FALLBACK",
    query,
  });
}

function searchRestaurantsStub({ destination, cuisine = [], dietary_restrictions = [], budget_level = "$$", area = null }) {
  const cat = catalogFor(destination);
  let list = cat.restaurants;
  if (area) {
    const near = list.filter((r) => r.cluster === area);
    if (near.length) list = near;
  }
  const options = list.slice(0, 4).map((r) => {
    const dietary_conflict = dietary_restrictions
      .filter((d) => {
        const dd = String(d).toLowerCase();
        // Flag when a restriction isn't covered by the restaurant's tags.
        if (dd.includes("vegan")) return !r.tags.includes("vegan");
        if (dd.includes("vegetarian")) return !(r.tags.includes("vegetarian") || r.tags.includes("vegan"));
        if (dd.includes("gluten")) return !r.tags.some((t) => t.includes("gluten"));
        return false;
      })
      .map((d) => `No confirmed "${d}" option`);
    return { ...r, dietary_conflict };
  });
  return {
    data_source: "stub",
    is_placeholder: IS_STUB,
    query: { destination, cuisine, dietary_restrictions, budget_level, area },
    options,
  };
}

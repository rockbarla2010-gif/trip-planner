// Amadeus Tours & Activities provider for the Attractions Agent.
//
// Real activity APIs return coordinates, not neighborhood names, so we cluster
// the results geographically and label each cluster by its most prominent stop
// ("Near <name>"). Clusters + their centroids flow downstream so the Hotel Agent
// can be biased toward them and the Itinerary Agent can group by area.
//
// Docs: https://developers.amadeus.com/self-service/category/destination-experiences

import { amadeusGet, resolveLocation, haversineKm } from "./amadeusCore.js";

const CLUSTER_RADIUS_KM = Number(process.env.CLUSTER_RADIUS_KM || 1.8);

// "2 hours" / "1 hour 30 minutes" / "Half day" / "Full day" -> hours (number)
function parseDurationText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (t.includes("full day")) return 6;
  if (t.includes("half day")) return 4;
  let hrs = 0;
  const h = /(\d+)\s*hour/.exec(t);
  const m = /(\d+)\s*min/.exec(t);
  if (h) hrs += Number(h[1]);
  if (m) hrs += Number(m[1]) / 60;
  return hrs > 0 ? +hrs.toFixed(1) : null;
}

// Greedy geographic clustering: assign each point to the first cluster whose
// centroid is within CLUSTER_RADIUS_KM, else start a new one.
function clusterByGeo(points) {
  const clusters = [];
  for (const p of points) {
    let placed = null;
    for (const c of clusters) {
      const d = haversineKm({ lat: p.lat, lon: p.lon }, { lat: c.lat, lon: c.lon });
      if (d != null && d <= CLUSTER_RADIUS_KM) {
        placed = c;
        break;
      }
    }
    if (!placed) {
      placed = { label: `Near ${p.name}`, lat: p.lat, lon: p.lon, members: [] };
      clusters.push(placed);
    }
    placed.members.push(p);
    // recompute centroid
    placed.lat = placed.members.reduce((s, m) => s + m.lat, 0) / placed.members.length;
    placed.lon = placed.members.reduce((s, m) => s + m.lon, 0) / placed.members.length;
  }
  return clusters;
}

export async function searchAttractionsAmadeus({ destination, interests = [], trip_days = 3, radiusKm = 15 }) {
  const loc = await resolveLocation(destination);
  if (loc.latitude == null || loc.longitude == null) {
    throw new Error(`Amadeus: no coordinates for "${destination}" to search activities`);
  }

  const json = await amadeusGet("/v1/shopping/activities", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    radius: Math.min(20, radiusKm), // API max 20km
  });

  const raw = (json.data || []).filter((a) => a.name && a.geoCode && a.geoCode.latitude != null);
  if (!raw.length) throw new Error(`Amadeus: no activities returned for "${destination}"`);

  // Bias toward interests by simple text match, then size to the trip length.
  const scored = raw
    .map((a) => {
      const hay = `${a.name} ${a.shortDescription || ""}`.toLowerCase();
      const score = interests.reduce((s, it) => s + (hay.includes(String(it).toLowerCase()) ? 1 : 0), 0);
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);

  const wanted = Math.max(2, Math.min(scored.length, Math.round(trip_days * 2.5)));
  const picked = scored.slice(0, wanted).map(({ a }) => ({
    raw: a,
    name: a.name,
    lat: a.geoCode.latitude,
    lon: a.geoCode.longitude,
  }));

  const clusters = clusterByGeo(picked);
  // map each activity to its cluster label
  const labelFor = new Map();
  for (const c of clusters) for (const m of c.members) labelFor.set(m, c.label);

  const attractions = picked.map((p) => {
    const a = p.raw;
    const bookable = Boolean(a.bookingLink);
    return {
      name: a.name,
      category: a.category || "Sight / Activity",
      time_needed_hrs: parseDurationText(a.minimumDuration) ?? 2,
      hours: null, // Amadeus activities don't expose opening hours
      booking: bookable ? "Advance booking available (online)" : "None",
      booking_link: a.bookingLink || null,
      rating: a.rating != null ? Number(a.rating) : null,
      price: a.price ? { amount: Number(a.price.amount), currency: a.price.currencyCode } : null,
      cluster: labelFor.get(p) || "Central",
      lat: p.lat,
      lon: p.lon,
    };
  });

  return {
    data_source: "amadeus",
    is_placeholder: false,
    query: { destination, interests, trip_days, city: loc.name },
    clusters: clusters.map((c) => c.label),
    cluster_centroids: clusters.map((c) => ({ label: c.label, lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5) })),
    attractions,
  };
}

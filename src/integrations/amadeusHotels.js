// Amadeus Hotel Search provider for the Hotel Agent.
//
// Two-step: list hotels in the destination city (with coordinates), rank them by
// real distance to the attraction-cluster centroids the Attractions Agent found,
// then price the closest candidates via the Hotel Offers API. Returns the SAME
// shape as the stub searchHotels so no agent logic changes.
//
// Docs: https://developers.amadeus.com/self-service/category/hotels

import { amadeusGet, resolveLocation, haversineKm } from "./amadeusCore.js";

const MAX_PRICED = Number(process.env.AMADEUS_HOTEL_CANDIDATES || 20); // hotelIds per offers call

function nightsBetween(start, end) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 1;
  return Math.max(1, Math.round((e - s) / 86400000));
}

// Nearest cluster centroid to a point -> { label, km }
function nearestCluster(point, centroids) {
  let best = { label: null, km: null };
  for (const c of centroids) {
    const km = haversineKm(point, { lat: c.lat, lon: c.lon });
    if (km != null && (best.km == null || km < best.km)) best = { label: c.label, km };
  }
  return best;
}

export async function searchHotelsAmadeus({
  destination,
  start_date,
  end_date,
  traveler_count = 1,
  budget = null,
  currency = "USD",
  near_clusters = [],
  near_cluster_centroids = [],
}) {
  const loc = await resolveLocation(destination);
  const nights = nightsBetween(start_date, end_date);

  // 1) list hotels in the city (includes coordinates)
  const list = await amadeusGet("/v1/reference-data/locations/hotels/by-city", {
    cityCode: loc.code,
    radius: 20,
    radiusUnit: "KM",
  });
  const hotels = (list.data || []).filter((h) => h.hotelId && h.geoCode);
  if (!hotels.length) throw new Error(`Amadeus: no hotels listed for "${destination}" (${loc.code})`);

  // 2) rank by proximity to attraction clusters (fallback: city center)
  const centroids =
    near_cluster_centroids && near_cluster_centroids.length
      ? near_cluster_centroids
      : [{ label: near_clusters[0] || "City center", lat: loc.latitude, lon: loc.longitude }];

  const ranked = hotels
    .map((h) => {
      const point = { lat: h.geoCode.latitude, lon: h.geoCode.longitude };
      const near = nearestCluster(point, centroids);
      return { h, point, near, ratingFromList: h.rating != null ? Number(h.rating) : null };
    })
    .sort((a, b) => (a.near.km ?? 1e9) - (b.near.km ?? 1e9));

  const candidates = ranked.slice(0, MAX_PRICED);
  const ratingById = new Map(candidates.map((c) => [c.h.hotelId, c.ratingFromList]));
  const nearById = new Map(candidates.map((c) => [c.h.hotelId, c.near]));

  // 3) price the closest candidates
  const offers = await amadeusGet("/v3/shopping/hotel-offers", {
    hotelIds: candidates.map((c) => c.h.hotelId).join(","),
    adults: traveler_count,
    checkInDate: start_date || undefined,
    checkOutDate: end_date || undefined,
    roomQuantity: 1,
    currency,
    bestRateOnly: "true",
  });

  const options = (offers.data || [])
    .filter((o) => o.available !== false && o.offers && o.offers.length)
    .map((o) => {
      const hotel = o.hotel || {};
      const offer = o.offers[0];
      const total = Number(offer.price.total);
      const near = nearById.get(hotel.hotelId) || { label: near_clusters[0] || "City center", km: null };
      const point = { lat: hotel.latitude, lon: hotel.longitude };
      const dist = near.km ?? nearestCluster(point, centroids).km;
      return {
        name: hotel.name || "Hotel",
        price_per_night: Math.round(total / nights),
        price_total_stay: Math.round(total),
        currency: offer.price.currency || currency,
        area: near.label || hotel.cityCode || loc.name,
        distance_to_clusters_km: dist,
        near_cluster: near.label,
        rating: hotel.rating != null ? Number(hotel.rating) : ratingById.get(hotel.hotelId) ?? null,
        lat: hotel.latitude ?? null,
        lon: hotel.longitude ?? null,
        offer_id: offer.id,
      };
    });

  if (!options.length) throw new Error(`Amadeus: hotels found but no bookable offers for those dates`);

  options.sort((a, b) => (a.distance_to_clusters_km ?? 1e9) - (b.distance_to_clusters_km ?? 1e9));

  return {
    data_source: "amadeus",
    is_placeholder: false,
    query: { destination, cityCode: loc.code, start_date, end_date, nights, traveler_count, currency },
    options: options.slice(0, 3),
    recommended_index: 0,
  };
}

// Amadeus Flight Offers provider. Shared plumbing lives in amadeusCore.js.
//
// Docs: https://developers.amadeus.com/self-service/category/flights

import { amadeusGet, resolveLocationCode, parseIsoDuration, titleCase } from "./amadeusCore.js";
export { amadeusConfigured } from "./amadeusCore.js";

function carrierName(dictionaries, code) {
  const name = dictionaries && dictionaries.carriers && dictionaries.carriers[code];
  return name ? titleCase(name) : code;
}

// Returns the SAME shape as the stub searchFlights.
export async function searchFlightsAmadeus({
  origin,
  destination,
  start_date,
  end_date,
  traveler_count = 1,
  currency = "USD",
  budget_ceiling = null,
  nonStop = false,
  max = 6,
}) {
  const [originCode, destCode] = await Promise.all([
    resolveLocationCode(origin),
    resolveLocationCode(destination),
  ]);

  const params = {
    originLocationCode: originCode,
    destinationLocationCode: destCode,
    departureDate: start_date,
    adults: traveler_count,
    currencyCode: currency,
    max,
    nonStop: nonStop ? "true" : undefined,
  };
  if (end_date) params.returnDate = end_date; // round trip when both dates given
  if (budget_ceiling && traveler_count) {
    const perPerson = Math.floor(budget_ceiling / traveler_count);
    if (perPerson > 50) params.maxPrice = perPerson;
  }

  const json = await amadeusGet("/v2/shopping/flight-offers", params);
  const dict = json.dictionaries || {};
  const offers = json.data || [];

  const options = offers.map((offer) => {
    const outbound = offer.itineraries[0];
    const inbound = offer.itineraries[1];
    const outSegs = outbound.segments;
    const layovers = outSegs.length - 1;

    const validating = (offer.validatingAirlineCodes && offer.validatingAirlineCodes[0]) || outSegs[0].carrierCode;
    const airline = carrierName(dict, validating);

    const outDur = parseIsoDuration(outbound.duration);
    const inDur = inbound ? parseIsoDuration(inbound.duration) : null;
    const timeLabel =
      `${outDur.label} outbound${layovers ? ` (${layovers} stop${layovers > 1 ? "s" : ""})` : " nonstop"}` +
      (inDur ? ` · ${inDur.label} return` : "");

    const perPerson = Number(offer.travelerPricings?.[0]?.price?.total ?? Number(offer.price.grandTotal) / traveler_count);
    const total = Number(offer.price.grandTotal);

    const warnings = [];
    if (layovers > 0) warnings.push("Layover(s) present — check transit-visa rules for connection airports.");

    return {
      airline,
      airline_code: validating,
      price_per_person: Math.round(perPerson),
      currency: offer.price.currency,
      price_total: Math.round(total),
      layovers,
      total_travel_time: timeLabel,
      transit_warnings: warnings,
      route: `${originCode}-${destCode}`,
      seats_remaining: offer.numberOfBookableSeats ?? null,
    };
  });

  options.sort((a, b) => a.price_per_person - b.price_per_person);

  return {
    data_source: "amadeus",
    is_placeholder: false,
    query: { origin, destination, originCode, destCode, start_date, end_date, traveler_count, currency },
    options: options.slice(0, 3),
  };
}

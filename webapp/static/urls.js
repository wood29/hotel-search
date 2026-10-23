// Builds each chain's normal search-results address for a city and dates.
// These are the same addresses the sites use when you search by hand.

const HotelUrls = (() => {
  const pad = (n) => String(n).padStart(2, "0");
  const parts = (iso) => { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; };
  const nights = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

  function build(p) {
    // p: { city, country, countryCode, lat, lon, checkIn: "YYYY-MM-DD", checkOut, adults }
    const ci = parts(p.checkIn), co = parts(p.checkOut);
    const n = nights(p.checkIn, p.checkOut);
    const place = `${p.city}, ${p.country}`;
    const enc = encodeURIComponent;
    const ukIn = `${pad(ci.d)}/${pad(ci.m)}/${ci.y}`, ukOut = `${pad(co.d)}/${pad(co.m)}/${co.y}`;

    const marriott = "https://www.marriott.com/en-gb/search/findHotels.mi?" + [
      `fromDate=${ukIn}`, `toDate=${ukOut}`, `t-start=${ukIn}`, `t-end=${ukOut}`,
      `lengthOfStay=${n}`, "roomCount=1", `numAdultsPerRoom=${p.adults}`, "childrenCount=0",
      "useRewardsPoints=true", "isSearch=true", "searchType=InCity", "destinationAddress.type=City",
      `destinationAddress.city=${enc(p.city)}`, `destinationAddress.country=${p.countryCode}`,
      `destinationAddress.destination=${enc(place)}`, `destinationAddress.address=${enc(place)}`,
      `destinationAddress.latitude=${p.lat}`, `destinationAddress.longitude=${p.lon}`,
      "searchRadius=50", "recordsPerPage=40", "view=list",
    ].join("&");

    const hiltonBase = "https://www.hilton.com/en/search/?" + [
      `query=${enc(place)}`, `arrivalDate=${p.checkIn}`, `departureDate=${p.checkOut}`,
      "flexibleDates=false", "numRooms=1", `numAdults=${p.adults}`, "numChildren=0",
    ].join("&");

    const ihgBase = "https://www.ihg.com/hotels/us/en/find-hotels/hotel-search?" + [
      `qDest=${enc(place)}`, `qCiD=${ci.d}`, `qCiMy=${pad(ci.m - 1)}${ci.y}`,
      `qCoD=${co.d}`, `qCoMy=${pad(co.m - 1)}${co.y}`, `qAdlt=${p.adults}`, "qChld=0", "qRms=1",
      "qSrt=sAV", "qBrs=", "qPSt=0",
    ].join("&");

    return [
      // searchPath: how to recognise the results page if the site rewrites the address;
      // marker: what tells the cash and the points page of the same site apart ("!" = must not contain).
      { key: "marriott", chain: "Marriott", kind: "cash+points", url: marriott, searchPath: "findHotels" },
      { key: "hilton-cash", chain: "Hilton", kind: "cash", url: hiltonBase, searchPath: "/search/", marker: "!redeemPts=true" },
      { key: "hilton-points", chain: "Hilton", kind: "points", url: hiltonBase + "&redeemPts=true", searchPath: "/search/", marker: "redeemPts=true" },
      { key: "ihg-cash", chain: "IHG", kind: "cash", url: ihgBase + "&qRtP=6CBARC", searchPath: "hotel-search", marker: "qRtP=6CBARC" },
      { key: "ihg-points", chain: "IHG", kind: "points", url: ihgBase + "&qRtP=IVANI", searchPath: "hotel-search", marker: "qRtP=IVANI" },
    ];
  }

  return { build, nights };
})();

if (typeof module !== "undefined") module.exports = HotelUrls;

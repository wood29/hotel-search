// Which brand a hotel belongs to, from its name — shown as a small letter badge (not the brands' logos)
// next to the hotel and on its map pin. Longer names first so "Holiday Inn Express" wins over "Holiday Inn".
const BRANDS = {
  Marriott: [
    ["JW Marriott", "JW"], ["Ritz-Carlton", "RC"], ["St. Regis", "SR"], ["EDITION", "ED"], ["Bulgari", "BUL"],
    ["Luxury Collection", "LC"], ["Autograph Collection", "AUT"], ["Tribute Portfolio", "TP"], ["Design Hotels", "DH"],
    ["Marriott Executive Apartments", "MEA"], ["Residence Inn", "RI"], ["Four Points", "FP"], ["Le Méridien", "LM"], ["Le Meridien", "LM"],
    ["Renaissance", "REN"], ["Westin", "WES"], ["Sheraton", "SHE"], ["Courtyard", "CY"], ["AC Hotel", "AC"], ["Moxy", "MOX"],
    ["Aloft", "ALO"], ["Element", "EL"], ["Fairfield", "FF"], ["SpringHill", "SH"], ["Delta Hotels", "DEL"], ["Protea", "PRO"],
    ["Gaylord", "GAY"], ["City Express", "CE"], [/^W\s|\sW\s/, "W"], ["Marriott", "MAR"],
  ],
  Hilton: [
    ["Waldorf Astoria", "WA"], ["Hilton Garden Inn", "HGI"], ["Hilton Grand Vacations", "HGV"], ["Embassy Suites", "ES"],
    ["DoubleTree", "DT"], ["Hampton", "HAM"], ["Homewood", "HW"], ["Home2", "H2"], ["Conrad", "CON"], ["LXR", "LXR"],
    ["Canopy", "CAN"], ["Curio", "CUR"], ["Tapestry", "TAP"], ["Signia", "SIG"], ["Motto", "MOT"], ["Tempo", "TEM"],
    ["Spark", "SPK"], ["Graduate", "GRA"], ["NoMad", "NOM"], ["SLH", "SLH"], ["Small Luxury", "SLH"], [/\bTru\b/, "TRU"], ["Hilton", "HIL"],
  ],
  IHG: [
    ["InterContinental", "IC"], ["Six Senses", "6S"], ["Regent", "REG"], ["Kimpton", "KIM"], ["Hotel Indigo", "IND"],
    ["Vignette", "VIG"], ["voco", "VOC"], ["Crowne Plaza", "CP"], ["Holiday Inn Express", "HIX"], ["Holiday Inn Club", "HIC"],
    ["Holiday Inn Resort", "HIR"], ["Holiday Inn", "HI"], ["Staybridge", "SB"], ["Candlewood", "CW"], ["avid", "AVD"],
    ["EVEN Hotel", "EVN"], ["Garner", "GAR"], ["Iberostar", "IBR"], ["atwell", "ATW"], ["Ruby", "RUB"], ["HUALUXE", "HUA"],
  ],
};
function brandOf(name, chain) {
  for (const [match, code] of BRANDS[chain] || []) {
    if (match instanceof RegExp ? match.test(name) : name.toLowerCase().includes(match.toLowerCase()))
      return { code, label: match instanceof RegExp ? code : match };
  }
  return { code: chain === "Marriott" ? "MAR" : chain === "Hilton" ? "HIL" : chain === "IHG" ? "IHG" : chain.slice(0, 3).toUpperCase(), label: chain };
}

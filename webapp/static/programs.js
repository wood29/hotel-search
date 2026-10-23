// Loyalty programmes: status tiers, how to reach them, what they get you, and a typical value per point
// (euro cents) used only to compare cash and points prices. Researched October 2026 from the programmes'
// help pages and reputable points sites (The Points Guy valuations, reisetopia, meilenoptimieren).
// Benefits are summaries — "if available" ones are at the hotel's discretion.
const PROGRAMS = [
  { id: "Marriott", mono: "MB", tone: "marriott", name: "Marriott Bonvoy", auto: true, centsPerPoint: 0.65,
    login: "https://www.marriott.com/en-gb/sign-in.mi", site: "https://www.marriott.com/en-gb/loyalty/myAccount/default.mi",
    tiers: [
      { name: "Member", qualify: "free", benefits: ["Member rates", "Free Wi-Fi", "Mobile check-in"] },
      { name: "Silver Elite", qualify: "10 nights a year", benefits: ["+10% bonus points", "Priority late checkout, if available"] },
      { name: "Gold Elite", qualify: "25 nights a year", benefits: ["2 pm late checkout, if available", "Room upgrade, if available", "Welcome gift: points", "+25% bonus points"] },
      { name: "Platinum Elite", qualify: "50 nights a year", benefits: ["Breakfast (not Ritz-Carlton, EDITION, Design Hotels)", "Lounge access", "Guaranteed 4 pm late checkout", "Upgrades incl. select suites", "+50% bonus points"] },
      { name: "Titanium Elite", qualify: "75 nights a year", benefits: ["All Platinum benefits", "Annual choice incl. a free night up to 40k", "48-hour room guarantee", "+75% bonus points"] },
      { name: "Ambassador Elite", qualify: "100 nights + US$23,000 spend a year", benefits: ["All Titanium benefits", "Your24: choose your check-in time", "Personal Ambassador service"] },
    ] },
  { id: "Hilton", mono: "HH", tone: "hilton", name: "Hilton Honors", auto: true, centsPerPoint: 0.35,
    login: "https://www.hilton.com/en/hilton-honors/login/", site: "https://www.hilton.com/en/hilton-honors/guest/my-account/",
    tiers: [
      { name: "Member", qualify: "free", benefits: ["Free Wi-Fi", "Digital key, choose your room"] },
      { name: "Silver", qualify: "10 nights, 4 stays or US$2,500 a year", benefits: ["+20% bonus points", "5th reward night free", "Bottled water"] },
      { name: "Gold", qualify: "25 nights, 15 stays or US$6,000 a year", benefits: ["Free breakfast (outside the US)", "Upgrade up to executive room, if available", "+80% bonus points", "5th reward night free"] },
      { name: "Diamond", qualify: "50 nights, 25 stays or US$11,500 a year", benefits: ["Executive lounge access", "Upgrade up to a one-bedroom suite, if available", "Free breakfast", "+100% bonus points", "48-hour room guarantee"] },
      { name: "Diamond Reserve", qualify: "80 nights + US$18,000 spend a year", benefits: ["Confirmable upgrade reward", "Guaranteed 4 pm late checkout", "Lounges and premium clubs", "+120% bonus points", "Dedicated 24/7 line"] },
    ] },
  { id: "IHG", mono: "IHG", tone: "ihg", name: "IHG One Rewards", auto: true, centsPerPoint: 0.5,
    login: "https://www.ihg.com/rewardsclub/us/en/sign-in", site: "https://www.ihg.com/rewardsclub/us/en/account-mgmt/home",
    tiers: [
      { name: "Club Member", qualify: "free", benefits: ["Member rates", "Free Wi-Fi", "Reward nights"] },
      { name: "Silver Elite", qualify: "10 nights a year", benefits: ["+20% bonus points", "Points don't expire", "2 pm late checkout, if available"] },
      { name: "Gold Elite", qualify: "20 nights or 40,000 points a year", benefits: ["+40% bonus points", "Milestone Rewards from 20 nights", "Rollover nights"] },
      { name: "Platinum Elite", qualify: "40 nights or 60,000 points a year", benefits: ["Upgrades incl. suites, if available", "+60% bonus points", "Early check-in, if available", "72-hour room guarantee"] },
      { name: "Diamond Elite", qualify: "70 nights or 120,000 points a year", benefits: ["Free breakfast as welcome amenity", "+100% bonus points", "Dedicated Diamond support", "Confirmable suite upgrades (milestones)"] },
    ] },
  { id: "ALL Accor", mono: "ALL", tone: "plain", name: "ALL Accor", centsPerPoint: 2.0,
    tiers: [
      { name: "Classic", qualify: "free", benefits: ["Member rates", "Free Wi-Fi"] },
      { name: "Silver", qualify: "10 nights or 2,000 status points", benefits: ["+25% bonus points", "Late checkout, if available", "Welcome drink"] },
      { name: "Gold", qualify: "30 nights or 7,000 status points", benefits: ["One-category upgrade, if available", "+50% bonus points", "Early check-in / late checkout", "Room guarantee"] },
      { name: "Platinum", qualify: "60 nights or 14,000 status points", benefits: ["Lounge access where available", "Suite upgrades, if available", "+75% bonus points"] },
      { name: "Diamond", qualify: "26,000 status points", benefits: ["+100% bonus points", "Weekend breakfast", "Dining and spa vouchers", "Gift Gold status"] },
    ] },
  { id: "Radisson Rewards", mono: "RR", tone: "plain", name: "Radisson Rewards", centsPerPoint: 0.2,
    tiers: [
      { name: "Club", qualify: "free", benefits: ["Member rates up to 15% off", "10% off food & drink"] },
      { name: "Premium", qualify: "5 nights or 3 stays a year", benefits: ["One-category upgrade, if available", "Early or late checkout (+2 h), if available", "Up to 20% off with Discount Booster"] },
      { name: "VIP", qualify: "30 nights or 20 stays a year", benefits: ["Free breakfast for two", "Best available room upgrade", "72-hour room guarantee", "VIP contact centre"] },
    ] },
  { id: "MeliáRewards", mono: "MR", tone: "plain", name: "MeliáRewards", centsPerPoint: 0.45,
    tiers: [
      { name: "White", qualify: "free", benefits: ["Member discounts", "Free Wi-Fi", "Birthday gift"] },
      { name: "Silver", qualify: "5 nights, 2 stays or 10,000 points", benefits: ["+10% points", "Breakfast for a companion (room-only rates)"] },
      { name: "Gold", qualify: "30 nights, 15 stays or 60,000 points", benefits: ["+30% points", "Late checkout, if available", "Priority arrival", "Three 20% discount vouchers a year"] },
      { name: "Platinum", qualify: "50 nights, 30 stays or 150,000 points", benefits: ["Upgrade, if available", "VIP lounge access (e.g. The Level)", "+40% points"] },
    ] },
  { id: "GHA DISCOVERY", mono: "GHA", tone: "plain", name: "GHA DISCOVERY", centsPerPoint: 86, unit: "D$",
    tiers: [
      { name: "Silver", qualify: "free", benefits: ["4% back in Discovery Dollars", "Member rates"] },
      { name: "Gold", qualify: "2 stays or US$1,000", benefits: ["5% back in Discovery Dollars"] },
      { name: "Platinum", qualify: "10 nights, US$5,000 or 2 brands", benefits: ["One-category upgrade, if available", "3 pm late checkout", "Welcome amenity", "6% back"] },
      { name: "Titanium", qualify: "30 nights, US$15,000 or 3 brands", benefits: ["Breakfast for two at participating brands", "Two-category upgrade, if available", "4 pm late checkout, 11 am check-in", "7% back"] },
    ] },
  { id: "Amex Membership Rewards", mono: "MR", tone: "plain", name: "Amex Membership Rewards", kind: "bank", centsPerPoint: null, tiers: [],
    note: "Austrian card. Transfers can't be undone and take 1–7 working days — Amex sometimes runs bonus offers (+30–50%). Accor is a new partner in Germany; not yet confirmed for Austria.",
    transfers: [
      { to: "Marriott", from: 3, get: 2 },
      { to: "Hilton", from: 1, get: 1 },
      { to: "Radisson Rewards", from: 1, get: 2 },
    ] },
];

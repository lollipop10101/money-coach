// Strategies registry — pure data, no side effects
// Import this from anywhere without triggering alert.mjs boot

export const STRATEGIES = [
  {
    id: "USDC-haSUI",
    label: "USDC → haSUI (2x borrow)",
    pair: "USDC/haSUI",
    direction: "SHORT",
    pool: "haSUI",
    side: "SHORT",
    rationale: "Borrow USDC at ~4%, convert to SUI at discount, return via haSUI. Max ~4% yield.",
    risk: "LOW",
    score: 50,
    apy: { supply: 0, borrow: 4.081, net: 4.081 },
    navxReward: 0.002
  },
  {
    id: "USDY-USDC",
    label: "USDY → USDC (best carry)",
    pair: "USDY/USDC",
    direction: "LONG",
    pool: "USDY",
    side: "LEND",
    rationale: "USDY supplies at 6.5%, USDC borrow at 4%. Net ~2.5% after incentives. Safe stable carry.",
    risk: "LOW",
    score: 85,
    apy: { supply: 6.589, borrow: 4.081, net: 2.508 },
    navxReward: 0.001
  },
  {
    id: "USDC-LBTC",
    label: "USDC → LBTC (bitcoin yield)",
    pair: "USDC/LBTC",
    direction: "LONG",
    pool: "LBTC",
    side: "LEND",
    rationale: "LBTC supply at 1.7%, low borrow on USDC. Neutral carry, NAVX upside if NAVX recovers.",
    risk: "MEDIUM",
    score: 58,
    apy: { supply: 1.732, borrow: 0.291, net: 1.441 },
    navxReward: 0.003
  },
  {
    id: "haSUI-SUI",
    label: "haSUI → SUI (short premium)",
    pair: "haSUI/SUI",
    direction: "SHORT",
    pool: "haSUI",
    side: "BORROW",
    rationale: "haSUI trades at 1.07x premium to SUI. Borrow haSUI, buy SUI, unwind when premium compresses.",
    risk: "MEDIUM",
    score: 60,
    apy: { supply: 0, borrow: 0.272, net: -0.272 },
    navxReward: 0.004
  }
];

export function getStrategies() {
  return STRATEGIES;
}
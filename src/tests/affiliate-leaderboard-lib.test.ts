// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mint: vi.fn() }));

vi.mock("../lib/stellar", () => ({ mintMilestoneBadgeContractCall: mocks.mint }));

import {
  MILESTONE_BADGES,
  claimMilestoneBadge,
  getAffiliatePrivacy,
  getAffiliateProfile,
  getClaimedBadges,
  getLeaderboardRankings,
  getMaskedPseudonym,
  getUserGrossSales,
  maskStellarAddress,
  saveClaimedBadge,
  setAffiliatePrivacy,
  setUserGrossSales,
} from "../lib/affiliateLeaderboard";
import type { ClaimedMilestoneRecord, MilestoneTier } from "../types/affiliateLeaderboard";

// Seed affiliate that ranks #1 on the monthly leaderboard.
const SEED_TOP = "GDXRN7VQK66EZM6PFFKYY2F6J6E4YQZ5YQ47T7V6PX6T3K42P37X2LTA";
const USER = "GUSER7VQK66EZM6PFFKYY2F6J6E4YQZ5YQ47T7V6PX6T3K42P37X2LTB";
const UNKNOWN = "GUNKNOWN7VQK66EZM6PFFKYY2F6J6E4YQZ5YQ47T7V6PX6T3K42P37";

function makeRecord(tier: MilestoneTier, affiliateAddress: string, tokenId = "SBT-TEST-1"): ClaimedMilestoneRecord {
  return {
    tier,
    tokenId,
    txHash: "0xabcdef1234567890",
    claimedAt: "2025-06-01T00:00:00Z",
    nonTransferable: true,
    tokenUri: "ipfs://bafybeistormbadges-test",
    contractAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    affiliateAddress,
  };
}

describe("milestone badge catalogue", () => {
  it("exposes three escalating tiers with matching thresholds", () => {
    expect(Object.keys(MILESTONE_BADGES).sort()).toEqual(["100k", "10k", "1k"]);
    expect(MILESTONE_BADGES["1k"].thresholdGrossSales).toBe(1000);
    expect(MILESTONE_BADGES["10k"].thresholdGrossSales).toBe(10000);
    expect(MILESTONE_BADGES["100k"].thresholdGrossSales).toBe(100000);
    expect(MILESTONE_BADGES["100k"].rarity).toBe("Legendary");
    expect(MILESTONE_BADGES["1k"].perks.length).toBeGreaterThan(0);
  });
});

describe("privacy and identity helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("reads and writes the per-address privacy flag", () => {
    expect(getAffiliatePrivacy(SEED_TOP)).toBe(false);

    setAffiliatePrivacy(SEED_TOP, true);
    expect(getAffiliatePrivacy(SEED_TOP)).toBe(true);

    setAffiliatePrivacy(SEED_TOP, false);
    expect(getAffiliatePrivacy(SEED_TOP)).toBe(false);

    // Empty address is a no-op and never readable.
    setAffiliatePrivacy("", true);
    expect(getAffiliatePrivacy("")).toBe(false);
  });

  it("masks Stellar addresses, falling back for short inputs", () => {
    expect(maskStellarAddress("GABC")).toBe("G***ANON");
    expect(maskStellarAddress("")).toBe("G***ANON");
    expect(maskStellarAddress(SEED_TOP)).toBe("G***2LTA");
  });

  it("derives a deterministic pseudonym", () => {
    expect(getMaskedPseudonym("")).toBe("StealthStormer#0000");
    const first = getMaskedPseudonym(SEED_TOP);
    const second = getMaskedPseudonym(SEED_TOP);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z]+#\d{4}$/);
  });
});

describe("claimed badge persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips records and ignores empty or corrupt input", () => {
    expect(getClaimedBadges("")).toEqual([]);
    expect(getClaimedBadges(SEED_TOP)).toEqual([]);

    saveClaimedBadge(makeRecord("1k", SEED_TOP));
    expect(getClaimedBadges(SEED_TOP)).toHaveLength(1);

    // Re-saving the same tier replaces the previous record.
    saveClaimedBadge(makeRecord("1k", SEED_TOP, "SBT-REPLACED"));
    const stored = getClaimedBadges(SEED_TOP);
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenId).toBe("SBT-REPLACED");

    saveClaimedBadge(makeRecord("10k", SEED_TOP));
    expect(getClaimedBadges(SEED_TOP)).toHaveLength(2);

    // Empty address writes are ignored.
    saveClaimedBadge(makeRecord("1k", ""));
    expect(getClaimedBadges("")).toEqual([]);

    // Corrupt entries degrade gracefully.
    localStorage.setItem(`stormsale_claimed_badges_${UNKNOWN}`, "{not-json");
    expect(getClaimedBadges(UNKNOWN)).toEqual([]);
  });
});

describe("gross sales helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns zeros for a missing address and determinism otherwise", () => {
    expect(getUserGrossSales("")).toEqual({ weekly: 0, monthly: 0, allTime: 0 });

    const first = getUserGrossSales(USER);
    const second = getUserGrossSales(USER);
    expect(first).toEqual(second);
    expect(first.monthly).toBeGreaterThanOrEqual(1250);
  });

  it("persists manual overrides and derives the dependent periods", () => {
    setUserGrossSales(USER, { monthly: 5000 });
    const derived = getUserGrossSales(USER);
    expect(derived.monthly).toBe(5000);
    expect(derived.weekly).toBe(Math.round(5000 * 0.28));
    expect(derived.allTime).toBe(Math.round(5000 * 4.2));

    setUserGrossSales(USER, { weekly: 100, monthly: 2000, allTime: 9000 });
    expect(getUserGrossSales(USER)).toEqual({ weekly: 100, monthly: 2000, allTime: 9000 });

    // Empty address is ignored without throwing.
    setUserGrossSales("", { monthly: 12345 });
    expect(getUserGrossSales("")).toEqual({ weekly: 0, monthly: 0, allTime: 0 });

    // Corrupt override falls back to the deterministic baseline.
    localStorage.setItem(`stormsale_user_sales_${USER}`, "{bad-json");
    expect(getUserGrossSales(USER).monthly).toBeGreaterThan(0);
  });
});

describe("leaderboard rankings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("returns the top 50 with consistent stats and ranks", () => {
    const { items, stats } = getLeaderboardRankings();
    expect(items).toHaveLength(50);
    expect(items[0].rank).toBe(1);
    expect(items[49].rank).toBe(50);
    expect(stats.activeAffiliatesCount).toBe(50);
    expect(stats.topAffiliateMonthlyVolume).toBe(items[0].monthlyGrossSales);
    expect(stats.totalBadgesClaimed).toBeGreaterThan(0);
    expect(stats.totalMonthlyVolume).toBeGreaterThan(0);
  });

  it("sorts by the requested timeframe", () => {
    const weekly = getLeaderboardRankings("weekly").items;
    expect(weekly[0].weeklyGrossSales).toBeGreaterThanOrEqual(weekly[1].weeklyGrossSales);

    const allTime = getLeaderboardRankings("all-time").items;
    expect(allTime[0].allTimeGrossSales).toBeGreaterThanOrEqual(allTime[1].allTimeGrossSales);

    const monthly = getLeaderboardRankings("monthly").items;
    expect(monthly[0].monthlyGrossSales).toBeGreaterThanOrEqual(monthly[1].monthlyGrossSales);
  });

  it("sorts by conversions and commission earnings", () => {
    const conversions = getLeaderboardRankings("monthly", "", "conversions").items;
    expect(conversions[0].verifiedSalesCount).toBeGreaterThanOrEqual(
      conversions[1].verifiedSalesCount,
    );

    const commission = getLeaderboardRankings("monthly", "", "commission").items;
    expect(commission[0].commissionEarnedXlm).toBeGreaterThanOrEqual(
      commission[1].commissionEarnedXlm,
    );
  });

  it("filters by address, pseudonym and rank, and returns an empty list otherwise", () => {
    const byPseudonym = getLeaderboardRankings("monthly", "ApexStormer").items;
    expect(byPseudonym).toHaveLength(1);
    expect(byPseudonym[0].pseudonym).toBe("ApexStormer#9942");

    const byAddress = getLeaderboardRankings("monthly", SEED_TOP.slice(0, 10)).items;
    expect(byAddress.some((item) => item.address === SEED_TOP)).toBe(true);

    const byMasked = getLeaderboardRankings("monthly", "2lta").items;
    expect(byMasked.some((item) => item.maskedAddress.endsWith("2LTA"))).toBe(true);

    const byRank = getLeaderboardRankings("monthly", "50").items;
    expect(byRank.length).toBeGreaterThanOrEqual(1);

    const noMatch = getLeaderboardRankings("monthly", "zzz-no-such-marketer").items;
    expect(noMatch).toEqual([]);
  });

  it("replaces an existing affiliate when the connected user is already ranked", () => {
    const { items, stats } = getLeaderboardRankings("monthly", "", "sales", SEED_TOP);
    expect(stats.activeAffiliatesCount).toBe(50);
    const mine = items.find((item) => item.address === SEED_TOP);
    expect(mine).toBeDefined();
    expect(mine?.pseudonym).toBe(getMaskedPseudonym(SEED_TOP));
    expect(mine?.avatarSeed).toBe("user");
  });

  it("appends a new affiliate for an unseen connected user", () => {
    const { stats } = getLeaderboardRankings("monthly", "", "sales", USER);
    expect(stats.activeAffiliatesCount).toBe(51);
  });

  it("reflects stored privacy settings and locally claimed badges", () => {
    setAffiliatePrivacy(SEED_TOP, true);
    saveClaimedBadge(makeRecord("1k", SEED_TOP, "SBT-LOCAL"));

    const { items } = getLeaderboardRankings("monthly");
    const mine = items.find((item) => item.address === SEED_TOP);
    expect(mine?.isPrivacyMasked).toBe(true);
    expect(mine?.claimedBadges).toHaveLength(1);
    expect(mine?.claimedBadges[0].tokenId).toBe("SBT-LOCAL");
  });
});

describe("affiliate profile", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("computes milestone progress for each volume band", () => {
    setUserGrossSales(USER, { monthly: 500 });
    const belowFirst = getAffiliateProfile(USER, USER);
    expect(belowFirst.unlockedTiers).toEqual([]);
    expect(belowFirst.nextMilestoneProgress.nextTier).toBe("1k");
    expect(belowFirst.nextMilestoneProgress.remainingSales).toBe(500);
    expect(belowFirst.nextMilestoneProgress.progressPercentage).toBe(50);
    expect(belowFirst.avatarSeed).toBe("current-user");

    setUserGrossSales(USER, { monthly: 1500 });
    const bronze = getAffiliateProfile(USER, USER);
    expect(bronze.unlockedTiers).toEqual(["1k"]);
    expect(bronze.nextMilestoneProgress.nextTier).toBe("10k");
    expect(bronze.nextMilestoneProgress.targetSales).toBe(10000);

    setUserGrossSales(USER, { monthly: 12500 });
    const silver = getAffiliateProfile(USER, USER);
    expect(silver.unlockedTiers).toEqual(["1k", "10k"]);
    expect(silver.nextMilestoneProgress.nextTier).toBe("100k");

    setUserGrossSales(USER, { monthly: 125000 });
    const titan = getAffiliateProfile(USER, USER);
    expect(titan.unlockedTiers).toEqual(["1k", "10k", "100k"]);
    expect(titan.nextMilestoneProgress.nextTier).toBeNull();
    expect(titan.nextMilestoneProgress.nextTierName).toBeNull();
    expect(titan.nextMilestoneProgress.remainingSales).toBe(0);
    expect(titan.nextMilestoneProgress.progressPercentage).toBe(100);
  });

  it("marks other affiliates and derives rank for unknown addresses", () => {
    setUserGrossSales(SEED_TOP, { monthly: 1500 });
    const ownProfile = getAffiliateProfile(SEED_TOP, USER);
    expect(ownProfile.avatarSeed).toBe(SEED_TOP.slice(0, 6));

    // A very low volume pushes the affiliate outside the top 50, exercising the rank fallback.
    setUserGrossSales(UNKNOWN, { monthly: 1300 });
    const unknown = getAffiliateProfile(UNKNOWN);
    expect(unknown.rank).toBe(51);
    expect(unknown.maskedAddress).toBe(maskStellarAddress(UNKNOWN));
  });

  it("surfaces claimed badges and privacy state", () => {
    setUserGrossSales(USER, { monthly: 1500 });
    saveClaimedBadge(makeRecord("1k", USER, "SBT-OWNED"));
    setAffiliatePrivacy(USER, true);

    const profile = getAffiliateProfile(USER, USER);
    expect(profile.claimedBadges).toHaveLength(1);
    expect(profile.claimedBadges[0].tokenId).toBe("SBT-OWNED");
    expect(profile.isPrivacyMasked).toBe(true);
  });
});

describe("claimMilestoneBadge", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("rejects an unknown tier", async () => {
    await expect(claimMilestoneBadge(USER, "bogus" as MilestoneTier)).rejects.toThrow(
      "Invalid milestone badge tier",
    );
  });

  it("rejects volumes that have not reached the threshold", async () => {
    setUserGrossSales(USER, { monthly: 500 });
    await expect(claimMilestoneBadge(USER, "1k")).rejects.toThrow(/Milestone not reached/);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("returns the existing record when the badge was already claimed", async () => {
    setUserGrossSales(USER, { monthly: 5000 });
    saveClaimedBadge(makeRecord("1k", USER, "SBT-EXISTING"));

    const record = await claimMilestoneBadge(USER, "1k");
    expect(record.tokenId).toBe("SBT-EXISTING");
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("mints on-chain, persists the record, and honours the wallet type", async () => {
    setUserGrossSales(USER, { monthly: 5000 });
    mocks.mint.mockResolvedValue({ tokenId: "SBT-MINTED", txHash: "0xfeed" });

    const record = await claimMilestoneBadge(USER, "1k", "albedo");
    expect(mocks.mint).toHaveBeenCalledWith(USER, "1k", "albedo");
    expect(record.tokenId).toBe("SBT-MINTED");
    expect(record.txHash).toBe("0xfeed");
    expect(record.nonTransferable).toBe(true);
    expect(getClaimedBadges(USER)).toHaveLength(1);

    mocks.mint.mockClear();
    setUserGrossSales(USER, { monthly: 12500 });
    await claimMilestoneBadge(USER, "10k");
    expect(mocks.mint).toHaveBeenCalledWith(USER, "10k", "freighter");
  });
});
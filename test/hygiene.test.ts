import { describe, expect, it } from "vitest";
import {
  DEFAULT_HYGIENE,
  HygieneError,
  validateHygiene
} from "../src/profiles/hygiene.js";

describe("hygiene config validation (ADR 0005)", () => {
  it("undefined/null/empty input yields the ADR 0005 defaults", () => {
    expect(validateHygiene(undefined)).toEqual(DEFAULT_HYGIENE);
    expect(validateHygiene(null)).toEqual(DEFAULT_HYGIENE);
    expect(validateHygiene({})).toEqual(DEFAULT_HYGIENE);
  });

  it("defaults are the ADR 0005 values", () => {
    expect(DEFAULT_HYGIENE).toEqual({
      thresholdPts: 5,
      deadBandPts: 2,
      cooldownHours: 4,
      dailyCap: 5,
      quietHours: { start: "22:00", end: "07:00" },
      liquidityFloorUsd: 1000
    });
  });

  it("partial input keeps provided fields and defaults the rest", () => {
    const cfg = validateHygiene({ thresholdPts: 10, dailyCap: 3 });
    expect(cfg.thresholdPts).toBe(10);
    expect(cfg.dailyCap).toBe(3);
    expect(cfg.deadBandPts).toBe(2);
    expect(cfg.quietHours).toEqual({ start: "22:00", end: "07:00" });
  });

  it("accepts numeric strings (form input)", () => {
    const cfg = validateHygiene({ thresholdPts: "7", liquidityFloorUsd: "500" });
    expect(cfg.thresholdPts).toBe(7);
    expect(cfg.liquidityFloorUsd).toBe(500);
  });

  it("enforces threshold bounds 1-50", () => {
    expect(() => validateHygiene({ thresholdPts: 0 })).toThrow(HygieneError);
    expect(() => validateHygiene({ thresholdPts: 51 })).toThrow(/thresholdPts/);
    expect(validateHygiene({ thresholdPts: 1 }).thresholdPts).toBe(1);
    expect(validateHygiene({ thresholdPts: 50 }).thresholdPts).toBe(50);
  });

  it("dead band is bounded by the threshold", () => {
    expect(() =>
      validateHygiene({ thresholdPts: 5, deadBandPts: 6 })
    ).toThrow(/deadBandPts/);
    expect(
      validateHygiene({ thresholdPts: 10, deadBandPts: 10 }).deadBandPts
    ).toBe(10);
    expect(validateHygiene({ deadBandPts: 0 }).deadBandPts).toBe(0);
  });

  it("enforces cooldown 0-48, cap 1-20, floor >= 0", () => {
    expect(() => validateHygiene({ cooldownHours: 49 })).toThrow(/cooldownHours/);
    expect(() => validateHygiene({ cooldownHours: -1 })).toThrow(HygieneError);
    expect(() => validateHygiene({ dailyCap: 0 })).toThrow(/dailyCap/);
    expect(() => validateHygiene({ dailyCap: 21 })).toThrow(/dailyCap/);
    expect(() => validateHygiene({ liquidityFloorUsd: -5 })).toThrow(
      /liquidityFloorUsd/
    );
    expect(validateHygiene({ liquidityFloorUsd: 0 }).liquidityFloorUsd).toBe(0);
  });

  it("rejects non-numeric garbage", () => {
    expect(() => validateHygiene({ thresholdPts: "lots" })).toThrow(
      /thresholdPts must be a number/
    );
  });

  it("validates quiet hours as HH:MM and defaults missing halves", () => {
    expect(
      validateHygiene({ quietHours: { start: "23:30" } }).quietHours
    ).toEqual({ start: "23:30", end: "07:00" });
    expect(() =>
      validateHygiene({ quietHours: { start: "25:00" } })
    ).toThrow(/quietHours.start/);
    expect(() => validateHygiene({ quietHours: { end: "7pm" } })).toThrow(
      /quietHours.end/
    );
    expect(() => validateHygiene({ quietHours: "night" })).toThrow(
      /quietHours/
    );
  });

  it("rejects non-object input", () => {
    expect(() => validateHygiene("nope")).toThrow(HygieneError);
    expect(() => validateHygiene([1, 2])).toThrow(HygieneError);
  });

  it("reports every problem in one error", () => {
    expect(() =>
      validateHygiene({ thresholdPts: 99, dailyCap: 0 })
    ).toThrow(/thresholdPts[\s\S]*dailyCap/);
  });
});

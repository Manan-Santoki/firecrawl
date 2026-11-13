import { evaluateCreditGate } from "../metering";

const none = {
  teamLimit: null,
  teamInterval: null,
  teamUsed: null,
  keyLimit: null,
  keyInterval: null,
  keyUsed: null,
};

describe("evaluateCreditGate", () => {
  it("is not a gate at all when no limit is set", () => {
    expect(evaluateCreditGate(none, 1000)).toBeNull();
  });

  it("allows within the team window and reports what is left", () => {
    expect(
      evaluateCreditGate(
        { ...none, teamLimit: 100, teamInterval: "day", teamUsed: 40 },
        10,
      ),
    ).toEqual({ allowed: true, remaining: 60, limitedBy: null });
  });

  it("refuses a request the team window cannot cover", () => {
    expect(
      evaluateCreditGate(
        { ...none, teamLimit: 100, teamInterval: "day", teamUsed: 95 },
        10,
      ),
    ).toEqual({ allowed: false, remaining: 5, limitedBy: "team" });
  });

  it("refuses at the key's own limit while the team still has credits", () => {
    const decision = evaluateCreditGate(
      {
        ...none,
        teamLimit: 1000,
        teamInterval: "month",
        teamUsed: 10,
        keyLimit: 5,
        keyInterval: "day",
        keyUsed: 5,
      },
      1,
    );
    expect(decision).toEqual({
      allowed: false,
      remaining: 990,
      limitedBy: "api_key",
    });
  });

  it("enforces a key limit on a team without one", () => {
    const decision = evaluateCreditGate(
      { ...none, keyLimit: 3, keyInterval: "week", keyUsed: 3 },
      1,
    );
    expect(decision?.allowed).toBe(false);
    expect(decision?.limitedBy).toBe("api_key");
    expect(Number.isFinite(decision?.remaining)).toBe(true);
  });

  it("treats an exhausted zero limit as disabled spending", () => {
    expect(
      evaluateCreditGate(
        { ...none, teamLimit: 0, teamInterval: "day", teamUsed: 0 },
        1,
      )?.allowed,
    ).toBe(false);
  });
});

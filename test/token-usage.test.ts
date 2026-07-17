import { describe, expect, it } from "bun:test";
import { addTokenUsage, emptyTokenUsage } from "../src/domain/workflow.js";
describe("token aggregation", () => {
  it("tracks each stage and total", () => {
    const one = addTokenUsage(emptyTokenUsage(), "initialRun", 100);
    const two = addTokenUsage(one, "repairs", 25);
    const three = addTokenUsage(two, "review", 10);
    expect(three).toEqual({ initialRun: 100, repairs: 25, review: 10, total: 135 });
  });
});

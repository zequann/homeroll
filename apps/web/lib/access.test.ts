import { describe, expect, it } from "vitest";
import { homeFor, mayOpen, surfacesFor } from "./access";

describe("which pages a wallet sees", () => {
  it("gives the owner the console and the lab, the worker and lender one page each", () => {
    expect(surfacesFor("Owner")).toEqual(["owner", "lab"]);
    expect(surfacesFor("Worker")).toEqual(["worker"]);
    expect(surfacesFor("Lender")).toEqual(["lender"]);
    expect(surfacesFor(null)).toEqual(["owner", "worker", "lab", "lender"]);
  });

  it("sends each wallet home to its own page", () => {
    expect(homeFor("Owner")).toBe("/owner");
    expect(homeFor("Worker")).toBe("/worker");
    expect(homeFor("Lender")).toBe("/lender");
  });

  it("keeps sub-pages with their surface and the landing page open to all", () => {
    expect(mayOpen("/worker/send/done", "Worker")).toBe(true);
    expect(mayOpen("/worker/cashout", "Owner")).toBe(false);
    expect(mayOpen("/lab", "Owner")).toBe(true);
    expect(mayOpen("/lab", "Lender")).toBe(false);
    expect(mayOpen("/", "Lender")).toBe(true);
    expect(mayOpen("/lender", null)).toBe(true);
    expect(mayOpen("/workers", "Worker")).toBe(true);
  });
});

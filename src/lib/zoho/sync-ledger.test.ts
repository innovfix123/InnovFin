import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileLedger, createMemoryLedger, hashPayload, makeReference } from "./sync-ledger";

describe("makeReference", () => {
  it("normalises parts into a stable, uppercase, dash-joined key", () => {
    expect(makeReference("REV", "Only Care", "2026-05")).toBe("REV-ONLY-CARE-2026-05");
    expect(makeReference("exp", "Agora.io", 2026)).toBe("EXP-AGORA-IO-2026");
  });
});

describe("hashPayload", () => {
  it("is independent of object key order", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });
  it("changes when the numbers change (so a re-run with new source data is detectable)", () => {
    expect(hashPayload({ taxable: 100 })).not.toBe(hashPayload({ taxable: 101 }));
  });
});

describe("memory ledger (idempotency)", () => {
  it("tracks pending → posted; wasPosted only true once posted", async () => {
    const ledger = createMemoryLedger();
    const ref = makeReference("REV", "Hima", "2026-05");
    expect(await ledger.wasPosted(ref)).toBe(false);

    await ledger.upsert({ reference: ref, kind: "revenue", entityKey: "Hima", period: "2026-05", payloadHash: "h1", status: "pending" });
    expect(await ledger.wasPosted(ref)).toBe(false);

    await ledger.upsert({ reference: ref, kind: "revenue", entityKey: "Hima", period: "2026-05", payloadHash: "h1", status: "posted", zohoId: "ZJ1" });
    expect(await ledger.wasPosted(ref)).toBe(true);

    const rec = await ledger.get(ref);
    expect(rec?.zohoId).toBe("ZJ1");
    expect(rec?.createdAt).toBeTruthy();
    expect(rec?.updatedAt).toBeTruthy();
  });
});

describe("file ledger (durability)", () => {
  it("persists records across separate instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zoho-ledger-"));
    const fp = path.join(dir, "ledger.json");
    const ref = makeReference("EXP", "Agora", "2026-04");
    try {
      const writer = createFileLedger(fp);
      await writer.upsert({ reference: ref, kind: "expense", entityKey: "Agora", period: "2026-04", payloadHash: "h", status: "posted", zohoId: "B9" });

      const reader = createFileLedger(fp); // fresh instance reads from disk
      expect(await reader.wasPosted(ref)).toBe(true);
      expect((await reader.get(ref))?.zohoId).toBe("B9");
      expect(await reader.all()).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import { POST } from "./route";

function csvFile(content: string, name: string): File {
  return new File([content], name, { type: "text/csv" });
}

describe("POST /api/sales", () => {
  it("computes GSTR-1 from manual uploads and marks the rest pending", async () => {
    const fd = new FormData();
    fd.set("period", "2026-05");
    fd.set("file:Bangalore Connect", csvFile("Transaction Status,Transaction Amount\nSUCCESS,118\nFAILED,99\nSUCCESS,236\n", "bc.csv"));
    fd.set("file:Sudar", csvFile("entity_id,type,amount\np1,payment,118\ns,settlement,9000\n", "sudar.csv"));

    const res = await POST(new Request("http://localhost/api/sales", { method: "POST", body: fd }));
    const json = await res.json();

    expect(json.total.taxable).toBeCloseTo(400, 2); // BC 300 + Sudar 100
    const bc = json.sources.find((s: { app: string }) => s.app === "Bangalore Connect");
    expect(bc.status).toBe("ok");
    expect(bc.mode).toBe("manual");
    const hima = json.sources.find((s: { app: string }) => s.app === "Hima");
    expect(hima.status).toBe("pending"); // no upload, no creds
  });
});

import { describe, it, expect } from "vitest";
import { POST } from "./route";

function csvFile(content: string, name: string): File {
  return new File([content], name, { type: "text/csv" });
}

describe("POST /api/sales", () => {
  it("computes GSTR-1 from manual uploads and marks the rest pending", async () => {
    const fd = new FormData();
    fd.set("period", "2026-05");
    fd.set("file:Sudar", csvFile("entity_id,type,amount\np1,payment,118\ns,settlement,9000\n", "sudar.csv"));

    const res = await POST(new Request("http://localhost/api/sales", { method: "POST", body: fd }));
    const json = await res.json();

    expect(json.total.taxable).toBeCloseTo(100, 2); // Sudar: 118 gross payment / 1.18; settlement row excluded
    const sudar = json.sources.find((s: { app: string }) => s.app === "Sudar");
    expect(sudar.status).toBe("ok");
    expect(sudar.mode).toBe("manual");
    const hima = json.sources.find((s: { app: string }) => s.app === "Hima");
    expect(hima.status).toBe("pending"); // no upload, no creds
  });
});

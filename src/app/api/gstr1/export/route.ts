import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

type Line = {
  app: string; taxable: number; igst: number; cgst: number; sgst: number;
  invoiceValueActual: number; roundOff: number; hsn?: number; count: number; basis: string;
};
type HsnRow = { hsn: number | string; taxable: number; igst: number; cgst: number; sgst: number };
type Total = { taxable: number; igst: number; cgst: number; sgst: number; invoiceValueActual: number; roundOff: number; count: number };

/** POST the computed GSTR-1 result JSON → download a formatted .xlsx working. */
export async function POST(req: Request) {
  const { period = "", lines = [], hsnRows = [], total } = (await req.json()) as {
    period?: string; lines?: Line[]; hsnRows?: HsnRow[]; total?: Total;
  };

  const working: (string | number)[][] = [
    ["InnovFin — GSTR-1 B2C Working", period],
    ["GSTIN", "29AAICI1603A1Z3"],
    [],
    ["App", "Taxable Value", "IGST", "CGST", "SGST", "Invoice Value", "Round Off", "HSN", "Count", "Basis"],
    ...lines.map((l) => [l.app, l.taxable, l.igst, l.cgst, l.sgst, l.invoiceValueActual, l.roundOff, l.hsn ?? "", l.count, l.basis]),
  ];
  if (total) {
    working.push(["TOTAL", total.taxable, total.igst, total.cgst, total.sgst, total.invoiceValueActual, total.roundOff, "", total.count, ""]);
  }

  const hsn: (string | number)[][] = [
    ["GSTR-1 Table 12 — HSN-wise summary", period],
    [],
    ["HSN", "Taxable Value", "IGST", "CGST", "SGST", "Total Tax"],
    ...hsnRows.map((r) => [r.hsn, r.taxable, r.igst, r.cgst, r.sgst, r.cgst + r.sgst + r.igst]),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(working), "GSTR-1 Working");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hsn), "HSN Summary");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const safePeriod = (period || "working").replace(/[^0-9A-Za-z_-]/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="GSTR-1 Working ${safePeriod}.xlsx"`,
    },
  });
}

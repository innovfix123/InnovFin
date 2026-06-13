import { z } from "zod";
import { computeRcm, type RcmResult } from "@/gst-core/rcm";
import type { Gstr3bInput } from "@/gst-core/gstr3b";

/** A single RCM-applicable expense line (vendor + INR paid) for server-side classification. */
export const rcmExpenseSchema = z.object({
  vendor: z.string(),
  amount: z.number(),
  incharge: z.string().optional(),
  status: z.string().optional(),
});

/**
 * Validated shape for a GSTR-3B computation request (shared by the compute + report routes).
 * RCM can be supplied two ways: pre-totalled (`rcm`), or as a raw expense list (`rcmExpenses`)
 * that the engine classifies via the RCM classifier. At least one must be present.
 */
export const gstr3bInputSchema = z
  .object({
    period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
    outward: z.object({
      taxable: z.number(),
      cgst: z.number(),
      sgst: z.number(),
      igst: z.number().optional(),
    }),
    rcm: z
      .object({
        foreign: z.object({ taxable: z.number(), igst: z.number() }),
        rent: z.object({ taxable: z.number(), cgst: z.number(), sgst: z.number() }),
      })
      .optional(),
    rcmExpenses: z.array(rcmExpenseSchema).optional(),
    itc2b: z.object({ taxable: z.number(), igst: z.number(), cgst: z.number(), sgst: z.number() }),
    itcReversed: z.object({ igst: z.number(), cgst: z.number(), sgst: z.number() }).optional(),
    lateFee: z.number().optional(),
    interest: z.number().optional(),
  })
  .refine((d) => d.rcm != null || d.rcmExpenses != null, {
    message: "provide either rcm totals or an rcmExpenses list",
    path: ["rcm"],
  });

export type Gstr3bInputParsed = z.infer<typeof gstr3bInputSchema>;

/**
 * Resolve a parsed request into the engine's `Gstr3bInput`. When a raw `rcmExpenses` list
 * is supplied, classify it (RCM classifier) and derive Table 3.1(d); otherwise use the
 * pre-totalled `rcm`. Returns the classification report when expenses were supplied, so the
 * caller can surface the "review" queue of unknown vendors.
 */
export function resolveRcm(d: Gstr3bInputParsed): { input: Gstr3bInput; rcmReport: RcmResult | null } {
  const rcmReport = d.rcmExpenses ? computeRcm(d.rcmExpenses) : null;
  const rcm = rcmReport
    ? {
        foreign: { taxable: rcmReport.foreign.taxable, igst: rcmReport.foreign.igst },
        rent: { taxable: rcmReport.rent.taxable, cgst: rcmReport.rent.cgst, sgst: rcmReport.rent.sgst },
      }
    : d.rcm!;
  return {
    input: {
      period: d.period,
      outward: d.outward,
      rcm,
      itc2b: d.itc2b,
      itcReversed: d.itcReversed,
      lateFee: d.lateFee,
      interest: d.interest,
    },
    rcmReport,
  };
}

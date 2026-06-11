import { z } from "zod";

/** Validated shape for a GSTR-3B computation request (shared by the compute + report routes). */
export const gstr3bInputSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  outward: z.object({
    taxable: z.number(),
    cgst: z.number(),
    sgst: z.number(),
    igst: z.number().optional(),
  }),
  rcm: z.object({
    foreign: z.object({ taxable: z.number(), igst: z.number() }),
    rent: z.object({ taxable: z.number(), cgst: z.number(), sgst: z.number() }),
  }),
  itc2b: z.object({ taxable: z.number(), igst: z.number(), cgst: z.number(), sgst: z.number() }),
  itcReversed: z.object({ igst: z.number(), cgst: z.number(), sgst: z.number() }).optional(),
  lateFee: z.number().optional(),
  interest: z.number().optional(),
});

export type Gstr3bInputParsed = z.infer<typeof gstr3bInputSchema>;

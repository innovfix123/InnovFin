/**
 * buildTdsWorkingServer — the TDS Working MCP: InnovFix's internal register (salary today; directors
 * and freelancers belong here too, alongside the same section math) — the assembled working, not a
 * per-app payout MCP like Only Care / Hima. Two tools: list_salary (per-employee 192/392 register)
 * and salary_summary (section roll-up + filed-anchor reconciliation).
 *
 * Both transports import this factory: the stdio entry (server.ts) and the networked HTTPS route.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSalary, salarySummary } from "./compute";
import { SALARY_REGISTER } from "./register";
import { assertPeriod } from "./util";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");
const EMPLOYEE = z.string().describe(`optional employee filter — id or name substring, one of: ${SALARY_REGISTER.map((e) => e.name).join(", ")}`);

/** Fresh, fully-wired TDS Working MCP server. Cheap to build — call once per stdio process or per HTTP request. */
export function buildTdsWorkingServer(): McpServer {
  const server = new McpServer({ name: "tds-working", version: "1.0.0" });

  server.registerTool("list_salary", {
    title: "List Section 192/392 salary register",
    description:
      "The per-employee Section-192 (392(1) under the 2025 Act) salary TDS register for a month, computed via tds-core.computeSalaryTds from the internal salary register (gross annual salary + opted regime — never from any app DB; salary is InnovFix-internal, not app-scoped). Input: period=YYYY-MM, optional employee filter (id or name substring, e.g. 'nandha'). Returns one row per employee: grossSalary, standardDeduction, taxableIncome, incomeTax (after 87A + marginal relief), cess (4% H&E), totalTax, monthlyTds (the challan figure), and any flags (e.g. surcharge territory, out-of-FY period). Ask for '192 salary', 'salary TDS', or an employee's salary TDS → this tool.",
    inputSchema: { period: PERIOD, employee: EMPLOYEE.optional() },
  }, async ({ period, employee }) => {
    assertPeriod(period);
    const r = listSalary(period, { employee });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("salary_summary", {
    title: "Section 192 salary roll-up + deposit",
    description:
      "The Section-192 section roll-up across the whole salary register for a month: employee count, total monthly TDS, a by-regime breakdown, the Form-24Q deposit block, and reconciliation against the filed May-2026 anchor (2 employees @ ₹18,00,000 gross NEW regime → ₹12,567 each → ₹25,134 total). regression.ok is true when the computed total matches the filed anchor for an in-FY period, null when the period falls outside FY 2026-27 (the anchor doesn't apply). Input: period=YYYY-MM. Ask for the salary TDS total, 192 deposit, or 'does this match what was filed' → this tool.",
    inputSchema: { period: PERIOD },
  }, async ({ period }) => {
    assertPeriod(period);
    const r = salarySummary(period);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const TDS_WORKING_TOOLS = ["list_salary", "salary_summary"] as const;

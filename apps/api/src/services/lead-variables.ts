// ============================================================
// Per-lead variables for campaign scripts (outbound_campaign_leads.variables).
//
// A lead can be sent as a plain number (as before) or as
//   { "phone_number": "9876543210", "variables": { "first_name": "Asha", "city": "Pune" } }
// and the campaign script's {{first_name}} / {{city}} placeholders are filled
// with that lead's values when the lead is called. The text is filled once,
// at call start, before the opening line is synthesized: nothing per turn.
//
// Limits per lead: 20 variables, names [A-Za-z_][A-Za-z0-9_]{0,39}, values up
// to 300 characters (numbers / booleans are turned into text), 2 KB in all.
// A placeholder with no value (unknown name, or no variables) becomes empty.
// ============================================================

import { z } from "zod";

export const LEAD_VARIABLES_MAX_KEYS = 20;
export const LEAD_VARIABLE_VALUE_MAX = 300;
export const LEAD_VARIABLES_MAX_BYTES = 2048;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export const leadVariablesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .superRefine((v, ctx) => {
    const keys = Object.keys(v);
    if (keys.length > LEAD_VARIABLES_MAX_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${LEAD_VARIABLES_MAX_KEYS} variables per lead` });
    }
    for (const k of keys) {
      if (!NAME_RE.test(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid variable name "${k.slice(0, 50)}" (letters, digits, _; max 40)` });
      const val = v[k];
      if (val != null && String(val).length > LEAD_VARIABLE_VALUE_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Variable "${k}" is longer than ${LEAD_VARIABLE_VALUE_MAX} characters` });
      }
    }
    if (Buffer.byteLength(JSON.stringify(v), "utf8") > LEAD_VARIABLES_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Variables of one lead may be at most ${LEAD_VARIABLES_MAX_BYTES} bytes` });
    }
  });

/** One lead in a request: a number, or a number with variables. */
export const leadInputSchema = z.union([
  z.string().min(3),
  z
    .object({
      phone_number: z.string().min(3).optional(),
      phone: z.string().min(3).optional(),
      variables: leadVariablesSchema.optional(),
    })
    .refine((o) => !!(o.phone_number ?? o.phone), { message: "phone_number is required" }),
]);

export type LeadInput = z.infer<typeof leadInputSchema>;
export type LeadVariables = Record<string, string>;

/** Splits a lead list into its numbers (same order) and the variables per number (last 10 digits). */
export function splitLeads(list: LeadInput[]): { phones: string[]; variables: Map<string, LeadVariables> } {
  const phones: string[] = [];
  const variables = new Map<string, LeadVariables>();
  for (const item of list) {
    if (typeof item === "string") {
      phones.push(item);
      continue;
    }
    const phone = (item.phone_number ?? item.phone)!;
    phones.push(phone);
    if (item.variables && Object.keys(item.variables).length > 0) {
      const clean: LeadVariables = {};
      for (const [k, v] of Object.entries(item.variables)) if (v != null) clean[k] = String(v);
      const key = phone.replace(/\D/g, "").slice(-10);
      if (key.length === 10) variables.set(key, clean);
    }
  }
  return { phones, variables };
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function hasPlaceholders(text: string | null | undefined): boolean {
  return !!text && text.includes("{{");
}

/**
 * Fills {{name}} placeholders. Unknown / missing values become empty, and the
 * spacing left behind is tidied ("Hello {{first_name}}, ..." with no name
 * becomes "Hello, ...").
 */
export function fillPlaceholders(text: string, vars: Record<string, unknown> | null | undefined): string {
  if (!hasPlaceholders(text)) return text;
  const filled = text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = vars?.[name];
    return v == null ? "" : String(v);
  });
  return filled
    .replace(/[ \t]+([,.!?।])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

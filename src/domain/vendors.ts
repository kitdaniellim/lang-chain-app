import type { Category } from "./schemas.js";

export interface Vendor {
  id: string;
  name: string;
  aliases: string[];
  emailDomain: string;
  address: string;
  taxId: string;
  approved: boolean;
  defaultCategory: Category;
}

/** Approved vendor registry (static for the demo). */
export const VENDORS: readonly Vendor[] = [
  { id: "v-001", name: "Acme Cloud Inc", aliases: ["Acme Cloud", "ACME CLOUD INCORPORATED"], emailDomain: "acmecloud.example", address: "123 Main St, Springfield, IL 62701", taxId: "US-84-1234567", approved: true, defaultCategory: "CLOUD_HOSTING" },
  { id: "v-002", name: "Northwind Software LLC", aliases: ["Northwind Software", "Northwind"], emailDomain: "northwind.example", address: "9 Harbour Rd, Seattle, WA 98101", taxId: "US-91-7654321", approved: true, defaultCategory: "SOFTWARE" },
  { id: "v-003", name: "Paperclip Office Supply Co", aliases: ["Paperclip Office Supply", "Paperclip"], emailDomain: "paperclip.example", address: "44 Elm Ave, Austin, TX 73301", taxId: "US-74-2223334", approved: true, defaultCategory: "OFFICE_SUPPLIES" },
  { id: "v-004", name: "Blue Harbor Consulting", aliases: ["Blue Harbor Consulting Group", "Blue Harbor"], emailDomain: "blueharbor.example", address: "200 Bay St, Boston, MA 02110", taxId: "US-04-5556667", approved: true, defaultCategory: "PROFESSIONAL_SERVICES" },
  { id: "v-005", name: "SkyLane Travel Partners", aliases: ["SkyLane Travel", "Skylane"], emailDomain: "skylane.example", address: "1 Terminal Dr, Denver, CO 80249", taxId: "US-84-8889990", approved: true, defaultCategory: "TRAVEL" },
  { id: "v-006", name: "Brightside Media Group", aliases: ["Brightside Media", "Brightside"], emailDomain: "brightside.example", address: "77 Sunset Blvd, Los Angeles, CA 90028", taxId: "US-95-1112223", approved: true, defaultCategory: "MARKETING" },
  { id: "v-007", name: "Metro Power & Water", aliases: ["Metro Power and Water", "Metro Utilities"], emailDomain: "metropw.example", address: "500 Grid Way, Chicago, IL 60601", taxId: "US-36-4445556", approved: true, defaultCategory: "UTILITIES" },
  { id: "v-008", name: "Ironclad Hardware Ltd", aliases: ["Ironclad Hardware", "Ironclad"], emailDomain: "ironclad.example", address: "12 Foundry Ln, Pittsburgh, PA 15222", taxId: "US-25-7778889", approved: true, defaultCategory: "EQUIPMENT" },
  { id: "v-009", name: "Quantum Analytics Corp", aliases: ["Quantum Analytics", "Quantum"], emailDomain: "quantumanalytics.example", address: "88 Data Dr, San Jose, CA 95110", taxId: "US-77-3334445", approved: true, defaultCategory: "SOFTWARE" },
  { id: "v-010", name: "Summit Legal Advisors", aliases: ["Summit Legal", "Summit Legal Advisors LLP"], emailDomain: "summitlegal.example", address: "3 Court Pl, New York, NY 10007", taxId: "US-13-6667778", approved: true, defaultCategory: "PROFESSIONAL_SERVICES" },
  { id: "v-011", name: "Greenleaf Facilities Services", aliases: ["Greenleaf Facilities", "Greenleaf"], emailDomain: "greenleaf.example", address: "61 Park Rd, Portland, OR 97204", taxId: "US-93-9990001", approved: true, defaultCategory: "OTHER" },
  { id: "v-012", name: "Pixel & Type Studio", aliases: ["Pixel and Type Studio", "Pixel & Type"], emailDomain: "pixeltype.example", address: "15 Gallery St, Brooklyn, NY 11201", taxId: "US-11-2224446", approved: true, defaultCategory: "MARKETING" },
];

export interface VendorMatch {
  vendor: Vendor;
  matchedOn: "name" | "alias";
  /** 1 = exact normalised match, lower = fuzzy */
  score: number;
}

const LEGAL_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|llp|group|plc)\b\.?/g;

/** Lower-case, strip punctuation and legal suffixes, collapse whitespace. */
export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact normalised match on name or alias first, then a conservative prefix/containment match. */
export function findVendor(name: string | null | undefined, registry: readonly Vendor[] = VENDORS): VendorMatch | null {
  if (!name) return null;
  const needle = normalizeVendorName(name);
  if (!needle) return null;

  for (const vendor of registry) {
    if (normalizeVendorName(vendor.name) === needle) return { vendor, matchedOn: "name", score: 1 };
    if (vendor.aliases.some((a) => normalizeVendorName(a) === needle)) return { vendor, matchedOn: "alias", score: 1 };
  }

  // Fuzzy: one normalised string contains the other and they share the first word.
  for (const vendor of registry) {
    const candidates = [vendor.name, ...vendor.aliases].map(normalizeVendorName);
    for (const candidate of candidates) {
      const shorter = candidate.length < needle.length ? candidate : needle;
      const longer = shorter === candidate ? needle : candidate;
      if (shorter.length >= 5 && longer.includes(shorter) && shorter.split(" ")[0] === longer.split(" ")[0]) {
        return { vendor, matchedOn: candidate === normalizeVendorName(vendor.name) ? "name" : "alias", score: 0.8 };
      }
    }
  }
  return null;
}

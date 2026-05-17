import type { Tsb } from "./types";

// NHTSA's TSB response field naming varies; parse defensively. Different
// vehicles return slightly different shapes, and the underlying API has
// changed over time.
interface NhtsaTsbRow {
  Manufacturer?: string;
  NHTSAItemNumber?: string;
  NHTSACampaignNumber?: string;
  Component?: string;
  Summary?: string;
  Description?: string;
  DateOfBulletin?: string;
  Date?: string;
}

interface NhtsaTsbResponse {
  count?: number;
  Count?: number;
  Message?: string;
  results?: NhtsaTsbRow[];
  Results?: NhtsaTsbRow[];
}

export async function fetchTsbs(
  year: string,
  make: string,
  model: string,
): Promise<Tsb[]> {
  const y = year.trim();
  const m = make.trim();
  const mo = model.trim();
  if (!y || !m || !mo) return [];

  const url =
    `https://api.nhtsa.gov/tsbs/tsbsByVehicle` +
    `?make=${encodeURIComponent(m)}` +
    `&model=${encodeURIComponent(mo)}` +
    `&modelYear=${encodeURIComponent(y)}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  let payload: NhtsaTsbResponse;
  try {
    payload = await res.json();
  } catch {
    return [];
  }

  const rows = payload.results ?? payload.Results ?? [];
  return rows
    .map((r): Tsb => {
      const summary = r.Summary ?? r.Description ?? "";
      return {
        number: r.NHTSAItemNumber ?? r.NHTSACampaignNumber ?? "",
        component: r.Component ?? "",
        summary,
        date: r.DateOfBulletin ?? r.Date,
      };
    })
    .filter((t) => t.number && (t.summary || t.component));
}

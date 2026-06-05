import type { Recall } from "./types";

interface NhtsaRecall {
  Manufacturer?: string;
  NHTSACampaignNumber?: string;
  Component?: string;
  Summary?: string;
  Consequence?: string;
  Remedy?: string;
  ReportReceivedDate?: string;
}

interface NhtsaRecallResponse {
  Count?: number;
  Message?: string;
  results?: NhtsaRecall[];
}

export async function fetchRecalls(
  year: string,
  make: string,
  model: string,
): Promise<Recall[]> {
  const y = year.trim();
  const m = make.trim();
  const mo = model.trim();
  if (!y || !m || !mo) return [];

  const url =
    `https://api.nhtsa.gov/recalls/recallsByVehicle` +
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

  let payload: NhtsaRecallResponse;
  try {
    payload = await res.json();
  } catch {
    return [];
  }

  const rows = Array.isArray(payload.results) ? payload.results : [];
  return rows
    .map((r) => ({
      campaignNumber: r.NHTSACampaignNumber ?? "",
      component: r.Component ?? "",
      summary: r.Summary ?? "",
      consequence: r.Consequence ?? "",
      remedy: r.Remedy ?? "",
      reportReceivedDate: r.ReportReceivedDate,
    }))
    .filter((r) => r.summary || r.component);
}

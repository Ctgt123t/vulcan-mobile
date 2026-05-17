import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  InspectionItem,
  InspectionItems,
  ItemStatus,
  Tsb,
  VehicleInfo,
} from "./types";

export interface InspectionSectionDef {
  id: string;
  title: string;
  items: { id: string; label: string }[];
}

export const INSPECTION_TEMPLATE: InspectionSectionDef[] = [
  {
    id: "exterior",
    title: "Exterior",
    items: [
      { id: "lights", label: "Lights (headlamps, brake, turn, reverse)" },
      { id: "wipers", label: "Wipers & washer spray" },
      { id: "glass", label: "Glass condition" },
      { id: "body", label: "Body condition" },
      { id: "tire_tread", label: "Tire tread depth" },
      { id: "tire_sidewall", label: "Tire sidewall condition" },
      { id: "tire_pressure", label: "Tire pressure" },
    ],
  },
  {
    id: "underhood",
    title: "Under Hood",
    items: [
      { id: "battery", label: "Battery & terminals" },
      { id: "belts", label: "Drive belts" },
      { id: "hoses", label: "Coolant & vacuum hoses" },
      { id: "oil_level", label: "Engine oil level / condition" },
      { id: "coolant_level", label: "Coolant level / condition" },
      { id: "brake_fluid", label: "Brake fluid level" },
      { id: "ps_fluid", label: "Power steering fluid" },
      { id: "washer_fluid", label: "Washer fluid" },
      { id: "air_filter", label: "Engine air filter" },
    ],
  },
  {
    id: "brakes",
    title: "Brakes",
    items: [
      { id: "front_pads", label: "Front brake pad thickness" },
      { id: "rear_pads", label: "Rear brake pad thickness" },
      { id: "rotors", label: "Rotor condition" },
      { id: "brake_lines", label: "Brake lines & hoses" },
      { id: "parking_brake", label: "Parking brake function" },
    ],
  },
  {
    id: "suspension",
    title: "Suspension & Steering",
    items: [
      { id: "shocks", label: "Shocks / struts" },
      { id: "tie_rods", label: "Tie rod ends" },
      { id: "ball_joints", label: "Ball joints" },
      { id: "cv_axles", label: "CV axles & boots" },
      { id: "steering_play", label: "Steering play" },
    ],
  },
  {
    id: "exhaust",
    title: "Exhaust",
    items: [
      { id: "exhaust_condition", label: "Pipe & muffler condition" },
      { id: "exhaust_leaks", label: "Leaks" },
      { id: "exhaust_hangers", label: "Hangers & isolators" },
    ],
  },
  {
    id: "drivetrain",
    title: "Drivetrain",
    items: [
      { id: "trans_fluid", label: "Transmission fluid" },
      { id: "diff_fluid", label: "Differential fluid" },
      { id: "transfer_case", label: "Transfer case (if applicable)" },
    ],
  },
];

export function buildEmptyItems(): InspectionItems {
  const out: InspectionItems = {};
  for (const section of INSPECTION_TEMPLATE) {
    for (const item of section.items) {
      out[item.id] = { status: null, notes: "", photoUri: undefined };
    }
  }
  return out;
}

export function totalItemCount(): number {
  return INSPECTION_TEMPLATE.reduce((n, s) => n + s.items.length, 0);
}

export function countByStatus(items: InspectionItems): {
  good: number;
  attention: number;
  urgent: number;
  completed: number;
} {
  let good = 0;
  let attention = 0;
  let urgent = 0;
  for (const item of Object.values(items)) {
    if (item.status === "good") good++;
    else if (item.status === "attention") attention++;
    else if (item.status === "urgent") urgent++;
  }
  return { good, attention, urgent, completed: good + attention + urgent };
}

// --- Draft persistence -------------------------------------------------------

export interface InspectionDraft {
  vehicle: VehicleInfo;
  vin: string;
  items: InspectionItems;
  phase: "intake" | "checklist" | "done";
}

const DRAFT_KEY = "vulcan:inspection:draft:v1";

export async function saveDraft(draft: InspectionDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch (err) {
    console.warn("[inspection] saveDraft failed:", err);
  }
}

export async function loadDraft(): Promise<InspectionDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as InspectionDraft;
  } catch (err) {
    console.warn("[inspection] loadDraft failed:", err);
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DRAFT_KEY);
  } catch {
    // best-effort
  }
}

// --- PDF HTML builder --------------------------------------------------------

export interface ShopInfo {
  name: string;
  address: string;
  phone: string;
}

// Placeholder shop info; future work can wire this to a settings screen.
export const SHOP_PLACEHOLDER: ShopInfo = {
  name: "[Shop Name]",
  address: "[Street Address, City, State ZIP]",
  phone: "[Shop Phone]",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusClass(status: ItemStatus): string {
  if (status === "good") return "good";
  if (status === "attention") return "attention";
  if (status === "urgent") return "urgent";
  return "none";
}

function statusLabel(status: ItemStatus): string {
  if (status === "good") return "Good";
  if (status === "attention") return "Needs Attention";
  if (status === "urgent") return "Urgent";
  return "Not Inspected";
}

export interface PdfBuildInput {
  shop: ShopInfo;
  vehicle: VehicleInfo;
  vin?: string;
  mileage: string;
  items: InspectionItems;
  date: string;
  tsbs?: Tsb[];
}

export function buildInspectionHtml(input: PdfBuildInput): string {
  const { shop, vehicle, vin, mileage, items, date, tsbs } = input;
  const counts = countByStatus(items);
  const total = totalItemCount();
  const tsbsArr = tsbs ?? [];

  const vehicleLine = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((s) => s && s.trim().length > 0)
    .join(" ");

  const sectionsHtml = INSPECTION_TEMPLATE.map((section) => {
    const rows = section.items
      .map((def) => {
        const item: InspectionItem = items[def.id] ?? {
          status: null,
          notes: "",
        };
        const notesHtml = item.notes
          ? `<div class="item-notes">${escapeHtml(item.notes)}</div>`
          : "";
        return `
          <div class="item">
            <div class="status-dot status-${statusClass(item.status)}"></div>
            <div class="item-body">
              <div class="item-label">${escapeHtml(def.label)}</div>
              <div class="item-status status-text-${statusClass(item.status)}">${statusLabel(item.status)}</div>
              ${notesHtml}
            </div>
          </div>`;
      })
      .join("");
    return `
      <div class="section">
        <div class="section-title">${escapeHtml(section.title)}</div>
        ${rows}
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vehicle Inspection Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1A1A1A; margin: 0; padding: 36px; }
    h1 { font-size: 24px; margin: 0 0 4px 0; letter-spacing: -0.3px; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #004B87; padding-bottom: 16px; margin-bottom: 24px; }
    .shop-name { font-size: 16px; font-weight: 700; color: #0A0A0A; }
    .shop-meta { color: #6B7280; font-size: 11px; margin-top: 2px; line-height: 1.5; }
    .report-meta { text-align: right; color: #6B7280; font-size: 11px; }
    .vehicle-card { background: #F5F6F7; border: 1px solid #E5E7EB; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; }
    .vehicle-line { font-size: 17px; font-weight: 600; color: #0A0A0A; margin-bottom: 6px; }
    .vehicle-meta { font-size: 12px; color: #6B7280; line-height: 1.7; }
    .vehicle-meta span { margin-right: 18px; }
    .summary { display: flex; gap: 10px; margin-bottom: 28px; }
    .summary-card { flex: 1; border-radius: 8px; padding: 12px 14px; border: 1px solid; }
    .summary-card .label { font-size: 10px; letter-spacing: 1.2px; font-weight: 700; margin-bottom: 4px; }
    .summary-card .count { font-size: 26px; font-weight: 700; line-height: 1; }
    .summary-good { background: #DCFCE7; border-color: #86EFAC; }
    .summary-good .label, .summary-good .count { color: #15803D; }
    .summary-attention { background: #FEF3C7; border-color: #FCD34D; }
    .summary-attention .label, .summary-attention .count { color: #92400E; }
    .summary-urgent { background: #FEE2E2; border-color: #FCA5A5; }
    .summary-urgent .label, .summary-urgent .count { color: #B91C1C; }
    .section { margin-bottom: 22px; }
    .section-title { font-size: 13px; font-weight: 700; letter-spacing: 1.5px; color: #004B87; border-bottom: 1px solid #E5E7EB; padding-bottom: 6px; margin-bottom: 10px; text-transform: uppercase; }
    .item { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid #F2F3F5; }
    .item:last-child { border-bottom: none; }
    .status-dot { width: 14px; height: 14px; border-radius: 7px; flex-shrink: 0; margin-top: 3px; border: 1px solid; }
    .status-good { background: #16A34A; border-color: #15803D; }
    .status-attention { background: #F59E0B; border-color: #B45309; }
    .status-urgent { background: #DC2626; border-color: #991B1B; }
    .status-none { background: #FFFFFF; border-color: #D1D5DB; }
    .item-body { flex: 1; }
    .item-label { font-size: 13px; color: #1A1A1A; }
    .item-status { font-size: 11px; margin-top: 1px; font-weight: 600; }
    .status-text-good { color: #15803D; }
    .status-text-attention { color: #92400E; }
    .status-text-urgent { color: #B91C1C; }
    .status-text-none { color: #6B7280; font-weight: 500; }
    .item-notes { font-size: 11px; color: #4B5563; margin-top: 4px; padding-left: 8px; border-left: 2px solid #E5E7EB; font-style: italic; }
    .tsb-block { margin-top: 22px; background: #DBEAFE; border: 1px solid #93C5FD; border-left: 4px solid #1E40AF; border-radius: 8px; padding: 14px 16px; }
    .tsb-title { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: #1E40AF; margin-bottom: 8px; }
    .tsb-intro { font-size: 12px; color: #1A1A1A; margin-bottom: 10px; line-height: 1.5; }
    .tsb-item { padding: 8px 0; border-top: 1px solid #93C5FD; }
    .tsb-item:first-of-type { border-top: none; }
    .tsb-number { font-size: 11px; font-weight: 700; color: #1E40AF; letter-spacing: 0.3px; }
    .tsb-summary { font-size: 12px; color: #1A1A1A; margin-top: 2px; line-height: 1.45; }
    .tsb-meta { font-size: 10px; color: #6B7280; margin-top: 2px; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #E5E7EB; font-size: 10px; color: #9CA3AF; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="shop-name">${escapeHtml(shop.name)}</div>
      <div class="shop-meta">${escapeHtml(shop.address)}<br>${escapeHtml(shop.phone)}</div>
    </div>
    <div class="report-meta">
      <div style="font-size:13px;font-weight:600;color:#0A0A0A;">Vehicle Inspection Report</div>
      <div>${escapeHtml(date)}</div>
    </div>
  </div>

  <div class="vehicle-card">
    <div class="vehicle-line">${escapeHtml(vehicleLine || "Unknown vehicle")}</div>
    <div class="vehicle-meta">
      ${vehicle.engineType ? `<span><strong>Engine:</strong> ${escapeHtml(vehicle.engineType)}</span>` : ""}
      ${mileage ? `<span><strong>Mileage:</strong> ${escapeHtml(mileage)} mi</span>` : ""}
      ${vin ? `<span><strong>VIN:</strong> ${escapeHtml(vin)}</span>` : ""}
    </div>
  </div>

  <div class="summary">
    <div class="summary-card summary-good">
      <div class="label">GOOD</div>
      <div class="count">${counts.good}</div>
    </div>
    <div class="summary-card summary-attention">
      <div class="label">NEEDS ATTENTION</div>
      <div class="count">${counts.attention}</div>
    </div>
    <div class="summary-card summary-urgent">
      <div class="label">URGENT</div>
      <div class="count">${counts.urgent}</div>
    </div>
  </div>

  ${sectionsHtml}

  ${
    tsbsArr.length > 0
      ? `<div class="tsb-block">
    <div class="tsb-title">OPEN TECHNICAL SERVICE BULLETINS · ${tsbsArr.length}</div>
    <div class="tsb-intro">The following manufacturer-issued bulletins apply to this vehicle. They are not warranty work but may relate to symptoms the customer reports.</div>
    ${tsbsArr
      .map(
        (t) => `
      <div class="tsb-item">
        <div class="tsb-number">TSB ${escapeHtml(t.number || "(unknown)")}${t.component ? ` · ${escapeHtml(t.component)}` : ""}</div>
        ${t.summary ? `<div class="tsb-summary">${escapeHtml(t.summary)}</div>` : ""}
        ${t.date ? `<div class="tsb-meta">Issued ${escapeHtml(t.date)}</div>` : ""}
      </div>`,
      )
      .join("")}
  </div>`
      : ""
  }

  <div class="footer">
    ${counts.completed} of ${total} items inspected · Generated by Vulcan
  </div>
</body>
</html>`;
}

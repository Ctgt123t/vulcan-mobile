// ============================================================================
// Light chat threads — PURE core (Ask+Diagnose merge plan, Phase 3).
//
// The persistence layer for the LIGHT (casual / Ask) chat channel, so a tech
// can leave any conversation mid-flight and return to it — the multitasking
// the two separate screens used to provide, required to land WITH or BEFORE
// the unified shell (VULCAN_MERGE_PLAN.md §1.10).
//
// Mirrors diagnosticCasesCore.ts discipline exactly: versioned envelope,
// tolerant never-throwing migrator (malformed / unversioned / FUTURE version
// → null; the storage layer never deletes an unreadable body), per-body
// storage keys + a lightweight index, pure prune selection, node-tested
// (lib/lightThreads.test.ts is the gate).
//
// DELIBERATELY NOT PERSISTED:
//  - assistant `diagrams` payloads — Brave ToS: transient in-memory only,
//    never stored (sanitizeMessages drops them). A restored thread renders
//    text + photo thumbnails; diagram cards do not survive leave-and-return
//    (the answer text describing/linking them does).
//  - image base64 — the lean rule; sanitizeMessages never restores it.
//
// Unlike diagnostic cases (patient charts), light threads have NO open/closed
// lifecycle and NO consent-gated prune: at the cap the oldest thread is
// deleted automatically — a casual chat is not a medical record.
// ============================================================================

import type { ChatMessage, VehicleInfo } from "./types";
import { sanitizeMessages } from "./diagnosticCasesCore";

export const LIGHT_SCHEMA_VERSION = 1 as const;

// Hard cap on stored light threads. Past the cap the OLDEST (by updatedAt) is
// deleted automatically — no consent UX (see module header).
export const LIGHT_CAP = 25;

// Storage keys — per-thread bodies + one index key, same shape as cases.
export const LIGHT_INDEX_KEY = "vulcan:threads:index:v1";
export function lightBodyKey(id: string): string {
  return `vulcan:threads:thread:${id}:v1`;
}
export const LIGHT_BODY_KEY_PREFIX = "vulcan:threads:thread:";

export interface LightThreadV1 {
  schemaVersion: number; // currently 1
  id: string;
  // The vehicle the thread was about AS OF its last turn (history, for the
  // list label + restore-on-open). null = no vehicle context.
  vehicle: VehicleInfo | null;
  vin: string | null;
  messages: ChatMessage[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
export type LightThread = LightThreadV1;

export interface LightThreadIndexEntry {
  id: string;
  schemaVersion: number;
  vehicleLabel: string | null;
  titlePreview: string;
  createdAt: string;
  updatedAt: string;
}

export function makeThreadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Small coercion helpers (defensive; never throw) -----------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sanitizeVehicleInfo(v: unknown): VehicleInfo | null {
  if (!isObj(v)) return null;
  const info: VehicleInfo = {
    year: str(v.year),
    make: str(v.make),
    model: str(v.model),
    series: typeof v.series === "string" ? v.series : undefined,
    trim: typeof v.trim === "string" ? v.trim : undefined,
    engineType: typeof v.engineType === "string" ? v.engineType : undefined,
    mileage: str(v.mileage),
  };
  return info.year || info.make || info.model ? info : null;
}

// ---- The migrator (the gate) ------------------------------------------------
//
// Tolerant by contract: malformed / truncated / unversioned / FUTURE-version
// input → null, NEVER throws. A null from here means "leave the body on disk
// untouched" at the storage layer (never-deletes invariant), exactly like
// migrateCase.
export function migrateLightThread(raw: unknown): LightThread | null {
  try {
    if (!isObj(raw)) return null;
    const v = raw.schemaVersion;
    if (typeof v !== "number" || v < 1 || v > LIGHT_SCHEMA_VERSION) return null;
    if (typeof raw.id !== "string" || raw.id.length === 0) return null;
    return {
      schemaVersion: LIGHT_SCHEMA_VERSION,
      id: raw.id,
      vehicle: sanitizeVehicleInfo(raw.vehicle),
      vin: typeof raw.vin === "string" && raw.vin.length > 0 ? raw.vin : null,
      messages: sanitizeMessages(raw.messages),
      createdAt: str(raw.createdAt, new Date(0).toISOString()),
      updatedAt: str(raw.updatedAt, new Date(0).toISOString()),
    };
  } catch {
    return null;
  }
}

// ---- Derivations ------------------------------------------------------------

// The list label: the first user message (what the chat is about). A photo-only
// opener labels as "Photo question"; an empty thread as "New chat".
export function threadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const text = firstUser.content.trim();
  if (text.length > 0) return text;
  return firstUser.image ? "Photo question" : "New chat";
}

export function lightVehicleLabel(t: Pick<LightThread, "vehicle" | "vin">): string | null {
  const name = t.vehicle
    ? [t.vehicle.year, t.vehicle.make, t.vehicle.model]
        .filter((s) => s && s.length > 0)
        .join(" ")
    : "";
  const tail = t.vin ? `…${t.vin.slice(-6)}` : "";
  if (name && tail) return `${name} · ${tail}`;
  return name || tail || null;
}

export function deriveLightIndexEntry(t: LightThread): LightThreadIndexEntry {
  return {
    id: t.id,
    schemaVersion: t.schemaVersion,
    vehicleLabel: lightVehicleLabel(t),
    titlePreview: threadTitle(t.messages).slice(0, 80),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---- Prune selection (pure) --------------------------------------------------
//
// At the cap, the oldest thread by updatedAt is the automatic victim. Returns
// null when under cap. No blocked/consent state (see module header).
export function selectLightPrune(
  index: LightThreadIndexEntry[],
  cap: number = LIGHT_CAP,
): string | null {
  if (index.length < cap) return null;
  const oldest = [...index].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  )[0];
  return oldest ? oldest.id : null;
}

// ---- Index reconciliation (self-heal) ----------------------------------------

export function reconcileLightIndex(
  bodyEntries: LightThreadIndexEntry[],
): LightThreadIndexEntry[] {
  const byId = new Map<string, LightThreadIndexEntry>();
  for (const e of bodyEntries) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

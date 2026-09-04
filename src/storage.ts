import type { Box, DesignAsset, DesignFrame, Mockup, ShapeKey, ShapePreset } from "./types";
import { DEFAULT_PRESETS, SHAPE_KEYS } from "./types";

const DB_NAME = "mockup-studio";
const STORE = "state";
const KEY = "current";
const LEGACY_LS_KEY = "mockup-studio-v2";

export interface PersistedSettings {
  shape: ShapeKey;
  backShape: ShapeKey;
  realism: number; // 0..1
  groupName: string; // base name for exported files
  format: "jpeg" | "png"; // export image format
  quality: "low" | "medium" | "high"; // export quality/size
  designFrames: Record<ShapeKey, DesignFrame>; // per-format pan/zoom of the design
  backDesignFrames: Record<ShapeKey, DesignFrame>; // independent back pan/zoom
  twoSided: boolean;
}

export interface PersistedState {
  mockups: Mockup[];
  presets: Record<ShapeKey, ShapePreset>;
  // The last uploaded design, so it's still there next time you open the app.
  design: DesignAsset | null;
  design2: DesignAsset | null;
  settings: PersistedSettings;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  shape: "short",
  backShape: "short",
  realism: 1,
  groupName: "group",
  format: "jpeg",
  quality: "high",
  designFrames: {
    short: { x: 0, y: 0, zoom: 1 },
    square: { x: 0, y: 0, zoom: 1 },
    long: { x: 0, y: 0, zoom: 1 },
  },
  backDesignFrames: {
    short: { x: 0, y: 0, zoom: 1 },
    square: { x: 0, y: 0, zoom: 1 },
    long: { x: 0, y: 0, zoom: 1 },
  },
  twoSided: false,
};

// Older versions stored a single Box per shape instead of an array. Wrap any
// bare box into a one-element array so old saved data keeps working.
function migrateMockups(mockups: Mockup[]): Mockup[] {
  return mockups.map((m) => {
    const placements: Mockup["placements"] = {};
    for (const k of SHAPE_KEYS) {
      const v = (m.placements as Record<string, Box | Box[] | undefined>)[k];
      if (!v) continue;
      placements[k] = Array.isArray(v) ? v : [v];
    }
    return { ...m, placements };
  });
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalize(v: Partial<PersistedState> | undefined): PersistedState {
  return {
    mockups: migrateMockups(v?.mockups ?? []),
    presets: v?.presets ?? DEFAULT_PRESETS,
    design: v?.design ?? null,
    design2: v?.design2 ?? null,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(v?.settings ?? {}),
      designFrames: {
        ...DEFAULT_SETTINGS.designFrames,
        ...((v?.settings as any)?.designFrames ?? {}),
      },
      backDesignFrames: {
        ...DEFAULT_SETTINGS.backDesignFrames,
        ...((v?.settings as any)?.backDesignFrames ?? {}),
      },
      twoSided: Boolean((v?.settings as any)?.twoSided && v?.design2),
    },
  };
}

export async function loadState(): Promise<PersistedState> {
  try {
    const db = await openDB();
    const stored = await new Promise<PersistedState | undefined>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result as PersistedState | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (stored) return normalize(stored);

    // One-time migration from the old localStorage store.
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        localStorage.removeItem(LEGACY_LS_KEY);
        return normalize(parsed);
      } catch {
        /* ignore bad legacy data */
      }
    }
    return normalize(undefined);
  } catch {
    return normalize(undefined);
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("Could not save state", e);
  }
}

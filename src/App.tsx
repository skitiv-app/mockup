import { useEffect, useMemo, useRef, useState } from "react";
import type { Box, Brand, DesignAsset, Mockup, ShapeKey, ShapePreset } from "./types";
import {
  SHAPE_KEYS,
  DEFAULT_PRESETS,
  BRANDS,
  DEFAULT_BRAND,
  pickShapeForRatio,
} from "./types";
import { loadState, saveState } from "./storage";
import {
  getImageSize,
  readFileAsDataURL,
  loadScaledMockup,
  renderMockup,
  downloadBlob,
  delay,
  urlToDataUrl,
} from "./render";
import { detectShirtBoxes } from "./autoplace";
import MockupCard from "./components/MockupCard";
import JSZip from "jszip";
import { useAuth0 } from "@auth0/auth0-react";
import { useSupabase } from "./auth/SupabaseProvider";
import { useIsOwner } from "./auth/useRole";
import { useApi } from "./api";
import {
  loadMockupsFromDb,
  saveMockupToDb,
  deleteMockupFromDb,
} from "./mockupsRepo";

const uid = () => Math.random().toString(36).slice(2, 9);

// Export quality presets: output scale + JPEG compression.
const QUALITY: Record<"low" | "medium" | "high", { scale: number; jpeg: number }> = {
  low: { scale: 0.5, jpeg: 0.6 },
  medium: { scale: 0.72, jpeg: 0.8 },
  high: { scale: 1, jpeg: 0.92 },
};

// Build a default placement box for a mockup + shape from the preset aspect ratio.
function defaultBox(mockup: Mockup, preset: ShapePreset): Box {
  const ratio = preset.w / preset.h;
  const w = mockup.width * 0.42;
  const h = w / ratio;
  return {
    x: (mockup.width - w) / 2,
    y: mockup.height * 0.5 - h / 2,
    w,
    h,
    rotation: 0,
  };
}

export default function App() {
  const [mockups, setMockups] = useState<Mockup[]>([]);
  const [presets, setPresets] =
    useState<Record<ShapeKey, ShapePreset>>(DEFAULT_PRESETS);
  const [shape, setShape] = useState<ShapeKey>("short");
  const [design, setDesign] = useState<DesignAsset | null>(null);
  const [realism, setRealism] = useState(0.6);
  const [toneFilter, setToneFilter] = useState<"all" | "light" | "dark">("all");
  const [brandFilter, setBrandFilter] = useState<"all" | Brand>("all");
  const [groupName, setGroupName] = useState("group");
  const [format, setFormat] = useState<"jpeg" | "png">("jpeg");
  const [quality, setQuality] = useState<"low" | "medium" | "high">("high");
  const [estimateMB, setEstimateMB] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  // Which mockups are ticked for export. New mockups start selected.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [autoShapeNote, setAutoShapeNote] = useState<ShapeKey | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Cloud (Supabase) wiring. When not configured, `supabase` is null and the
  // app falls back to local-only IndexedDB behaviour.
  const supabase = useSupabase();
  const { user } = useAuth0();
  const orgId = (user as any)?.org_id as string | undefined;
  const userId = (user?.sub as string | undefined) ?? null;
  const isOwner = useIsOwner();
  const api = useApi();
  const cloud = supabase && orgId ? { supabase, orgId } : null;

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000);
  }

  // Load saved state from IndexedDB once on mount.
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    loadState().then((s) => {
      if (cancelled) return;
      // If the cloud is on, mockups come from Supabase (loaded in the effect
      // below); otherwise use the local cache.
      if (!cloud) {
        setMockups(s.mockups);
        setSelected(new Set(s.mockups.map((m) => m.id)));
      }
      setPresets(s.presets);
      setDesign(s.design);
      setShape(s.settings.shape);
      setRealism(s.settings.realism);
      setGroupName(s.settings.groupName);
      setFormat(s.settings.format);
      setQuality(s.settings.quality);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // When the cloud is configured, mockups live in Supabase. Load the org's
  // saved mockups and use them as the source of truth (local list is replaced).
  useEffect(() => {
    if (!cloud) return;
    let cancelled = false;
    loadMockupsFromDb(cloud.supabase)
      .then((remote) => {
        if (cancelled) return;
        setMockups(remote);
        setSelected(new Set(remote.map((m) => m.id)));
      })
      .catch((e) => flash("Couldn't load cloud mockups: " + (e?.message ?? e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud?.supabase, cloud?.orgId]);

  // Keep the latest state in a ref so we can flush it synchronously on close.
  const latest = useRef({ mockups, presets, design, shape, realism, groupName, format, quality, cloudActive: false });
  latest.current = { mockups, presets, design, shape, realism, groupName, format, quality, cloudActive: !!cloud };
  const flush = () => {
    if (!loaded.current) return;
    const l = latest.current;
    saveState({
      // With the cloud on, mockups live in Supabase; don't cache them locally
      // (signed URLs expire). Presets/design/settings stay local for convenience.
      mockups: l.cloudActive ? [] : l.mockups,
      presets: l.presets,
      design: l.design,
      settings: {
        shape: l.shape,
        realism: l.realism,
        groupName: l.groupName,
        format: l.format,
        quality: l.quality,
      },
    });
  };

  // Debounced save — never write on every drag frame; wait until edits settle.
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded.current) return; // don't overwrite storage before load finishes
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [mockups, presets, design, shape, realism, groupName, format, quality]);

  // Also flush immediately when the tab is hidden or closing, so nothing is
  // lost if you quit within the debounce window.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  async function onAddMockups(files: FileList | null) {
    if (!files) return;
    const added: Mockup[] = [];
    for (const file of Array.from(files)) {
      const { src, width, height } = await loadScaledMockup(file);
      added.push({
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ""),
        src,
        width,
        height,
        placements: {},
      });
    }
    setMockups((m) => [...m, ...added]);
    setSelected((s) => {
      const next = new Set(s);
      added.forEach((m) => next.add(m.id));
      return next;
    });
  }

  async function onSetDesign(files: FileList | null) {
    if (!files || !files[0]) return;
    const file = files[0];
    const src = await readFileAsDataURL(file);
    const { width, height } = await getImageSize(src);
    setDesign({ src, width, height, name: file.name.replace(/\.[^.]+$/, "") });
    // Auto-pick the shape whose aspect ratio matches this design.
    const picked = pickShapeForRatio(width, height, presets);
    setShape(picked);
    setAutoShapeNote(picked);
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Select/deselect a specific group of mockups (used per Light/Dark section).
  function setGroupSelected(ids: string[], on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  // Boxes for a mockup at the active shape, creating a single default if none
  // are saved yet.
  function boxesFor(mockup: Mockup): Box[] {
    const saved = mockup.placements[shape];
    if (saved && saved.length) return saved;
    return [defaultBox(mockup, presets[shape])];
  }

  function updateBoxes(id: string, boxes: Box[]) {
    setMockups((list) =>
      list.map((m) =>
        m.id === id
          ? { ...m, placements: { ...m.placements, [shape]: boxes } }
          : m
      )
    );
  }

  // Add a second (or third…) spot to a mockup for the active shape, so photos
  // with more than one shirt can each get the design. New spot is nudged down
  // and right so it doesn't sit exactly on top of the last one.
  function addBox(id: string) {
    setMockups((list) =>
      list.map((m) => {
        if (m.id !== id) return m;
        const boxes = boxesFor(m);
        const base = boxes[boxes.length - 1];
        const nx = Math.min(base.x + base.w * 0.25, m.width - base.w);
        const ny = Math.min(base.y + base.h * 0.25, m.height - base.h);
        const added: Box = { ...base, x: Math.max(0, nx), y: Math.max(0, ny) };
        return { ...m, placements: { ...m.placements, [shape]: [...boxes, added] } };
      })
    );
  }

  function removeBox(id: string, index: number) {
    setMockups((list) =>
      list.map((m) => {
        if (m.id !== id) return m;
        const boxes = boxesFor(m).filter((_, i) => i !== index);
        return { ...m, placements: { ...m.placements, [shape]: boxes } };
      })
    );
  }

  // Copy one mockup's layout for the active shape to every other (unlocked)
  // mockup. Boxes are converted to fractions of the source's size and re-scaled
  // to each target's size, so it works even when photos differ in resolution.
  function applyLayoutToAll(sourceId: string) {
    const source = mockups.find((m) => m.id === sourceId);
    if (!source) return;
    const boxes = boxesFor(source);
    const frac = boxes.map((b) => ({
      x: b.x / source.width,
      y: b.y / source.height,
      w: b.w / source.width,
      h: b.h / source.height,
      rotation: b.rotation ?? 0,
    }));
    setMockups((list) =>
      list.map((m) => {
        if (m.id === sourceId || m.locked) return m;
        const scaled: Box[] = frac.map((f) => ({
          x: f.x * m.width,
          y: f.y * m.height,
          w: f.w * m.width,
          h: f.h * m.height,
          rotation: f.rotation,
        }));
        return { ...m, placements: { ...m.placements, [shape]: scaled } };
      })
    );
  }

  // Auto-place: scan the photo, find the shirt(s), and drop a spot on each for
  // the active shape. It's an "autocomplete" — the user can still nudge/resize.
  async function autoPlaceOne(id: string): Promise<number> {
    const m = mockups.find((x) => x.id === id);
    if (!m || m.locked) return 0;
    const boxes = await detectShirtBoxes(m.src, m.width, m.height, presets[shape], 2);
    if (boxes.length) updateBoxes(id, boxes);
    return boxes.length;
  }

  async function autoPlaceCard(id: string) {
    setAutoBusy(true);
    try {
      const n = await autoPlaceOne(id);
      flash(
        n === 0
          ? "Couldn't find a shirt automatically — place it by hand."
          : n === 1
          ? "Placed 1 spot ✨"
          : `Found ${n} shirts — placed ${n} spots ✨`
      );
    } finally {
      setAutoBusy(false);
    }
  }

  async function autoPlaceAll() {
    setAutoBusy(true);
    let found = 0;
    let missed = 0;
    try {
      for (const m of mockups) {
        if (m.locked) continue;
        const n = await autoPlaceOne(m.id);
        n > 0 ? (found += 1) : (missed += 1);
      }
      flash(
        `Auto-placed ${found} mockup${found === 1 ? "" : "s"}` +
          (missed ? ` · ${missed} need${missed === 1 ? "s" : ""} manual placing` : " ✨")
      );
    } finally {
      setAutoBusy(false);
    }
  }

  function removeMockup(id: string) {
    if (!isOwner) {
      flash("Only owners can remove mockups.");
      return;
    }
    const target = mockups.find((m) => m.id === id);
    setMockups((list) => list.filter((m) => m.id !== id));
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    if (cloud && target?.imagePath) {
      deleteMockupFromDb(cloud.supabase, target).catch((e) =>
        flash("Cloud delete failed: " + (e?.message ?? "error"))
      );
    }
  }

  // Lock freezes all placements. When locking, fill in any shape the user
  // hasn't placed yet with its default box, so all three are saved concretely.
  async function toggleLock(id: string) {
    const target = mockups.find((m) => m.id === id);
    if (!target) return;
    const willLock = !target.locked;

    // Members are read-only: only owners can lock/unlock (server enforces via
    // RLS + trigger).
    if (!isOwner) {
      flash("Only owners can lock or change mockups.");
      return;
    }

    // Build the updated mockup synchronously (NOT inside the setState updater —
    // React runs that callback lazily, so reading it back was unreliable and
    // sometimes skipped the save).
    let placements = target.placements;
    if (willLock) {
      placements = { ...target.placements };
      for (const k of SHAPE_KEYS) {
        if (!placements[k]?.length)
          placements[k] = [defaultBox(target, presets[k])];
      }
    }
    const updated: Mockup = { ...target, locked: willLock, placements };
    setMockups((list) => list.map((m) => (m.id === id ? updated : m)));

    // Persist to the cloud when configured. Locking uploads + upserts; the
    // owner unlocking flips the flag back.
    if (cloud) {
      try {
        if (willLock) {
          const path = await saveMockupToDb(cloud.supabase, updated, cloud.orgId, userId);
          setMockups((list) =>
            list.map((m) => (m.id === id ? { ...m, imagePath: path } : m))
          );
          flash("Mockup locked & saved to the cloud ✓");
        } else {
          // Unlock now REMOVES the mockup from the cloud (row + stored image).
          // Keep the image locally (cloud mockups use a signed URL) so a future
          // lock can re-upload it.
          let localSrc = updated.src;
          if (updated.imagePath && !localSrc.startsWith("data:")) {
            try {
              localSrc = await urlToDataUrl(updated.src);
            } catch {
              /* fall back to the URL; re-lock may need a re-add */
            }
          }
          await deleteMockupFromDb(cloud.supabase, updated);
          setMockups((list) =>
            list.map((m) =>
              m.id === id ? { ...m, src: localSrc, imagePath: undefined } : m
            )
          );
          flash("Unlocked — removed from the cloud.");
        }
      } catch (e: any) {
        flash("Cloud save failed: " + (e?.message ?? "error"));
      }
    } else {
      flash(willLock ? "Locked (local only — no cloud configured)" : "Unlocked.");
    }
  }

  function setTone(id: string, tone: "light" | "dark") {
    if (!isOwner) return;
    setMockups((list) => list.map((m) => (m.id === id ? { ...m, tone } : m)));
  }

  function setBrand(id: string, brand: Brand) {
    if (!isOwner) return;
    setMockups((list) => list.map((m) => (m.id === id ? { ...m, brand } : m)));
  }

  // Render one mockup and put the finished image on the clipboard, ready to
  // paste into a listing, Canva, chat, etc.
  async function copyMockup(id: string) {
    const m = mockups.find((x) => x.id === id);
    if (!m) return;
    if (!design) {
      flash("Add a design first, then copy the mockup");
      return;
    }
    if (!navigator.clipboard || !("write" in navigator.clipboard) || !window.ClipboardItem) {
      flash("This browser can't copy images to the clipboard");
      return;
    }
    try {
      // ClipboardItem accepts the blob Promise, keeping it inside the click
      // gesture while the image renders.
      const blob = renderMockup(m, boxesFor(m), design, {
        realism,
        garment: m.tone ?? "light",
        mime: "image/png",
      });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      flash("Mockup copied — paste it anywhere ✓");
    } catch {
      flash("Couldn't copy the mockup image");
    }
  }

  function updatePreset(key: ShapeKey, patch: Partial<ShapePreset>) {
    if (!isOwner) return;
    setPresets((p) => ({ ...p, [key]: { ...p[key], ...patch } }));
  }

  async function exportSelected() {
    if (!design) return;
    const targets = mockups.filter((m) => selected.has(m.id));
    if (targets.length === 0) return;

    // Preferred path: user picks ONE folder, we write every PNG into it.
    // (Chrome/Edge — File System Access API.)
    const picker = (window as any).showDirectoryPicker;
    let dir: any = null;
    if (picker) {
      try {
        dir = await picker({ mode: "readwrite" });
      } catch {
        return; // user cancelled the folder chooser
      }
    }

    // Files are named "<group>-1.png", "<group>-2.png", ... in selection order,
    // zero-padded so they sort correctly in the folder.
    const base = (groupName.trim() || "group").replace(/[\\/:*?"<>|]+/g, "-");
    const pad = String(targets.length).length;
    const mime = format === "jpeg" ? "image/jpeg" : "image/png";
    const ext = format === "jpeg" ? "jpg" : "png";
    const q = QUALITY[quality];

    setExporting(true);
    try {
      // Render everything first, then hand the files off together — this keeps
      // the fallback downloads in one burst so the browser treats them as a
      // single "download these files" action instead of prompting per file.
      const files: { name: string; blob: Blob }[] = [];
      let i = 0;
      for (const m of targets) {
        const blob = await renderMockup(m, boxesFor(m), design, {
          realism,
          garment: m.tone ?? "light",
          mime,
          quality: q.jpeg,
          outScale: q.scale,
        });
        i += 1;
        files.push({
          name: `${base}-${String(i).padStart(pad, "0")}.${ext}`,
          blob,
        });
      }

      if (dir) {
        for (const f of files) {
          const fh = await dir.getFileHandle(f.name, { create: true });
          const w = await fh.createWritable();
          await w.write(f.blob);
          await w.close();
        }
        flash(`Saved ${files.length} images to your folder ✓`);
      } else if (files.length === 1) {
        // Single image — just download it directly.
        downloadBlob(files[0].blob, files[0].name);
        flash("Downloaded 1 image ✓");
      } else {
        // No folder API (not Chrome/Edge) — bundle into ONE zip so the browser
        // asks once, not per image.
        const zip = new JSZip();
        for (const f of files) zip.file(f.name, f.blob);
        const blob = await zip.generateAsync({ type: "blob" });
        downloadBlob(blob, `${base}.zip`);
        flash(`Saved ${files.length} images as ${base}.zip ✓`);
      }
      // Record this export for the workspace's activity report (owner view).
      if (cloud) {
        api("/api/log-export", {
          method: "POST",
          body: { count: files.length, format, quality, email: user?.email },
        }).catch(() => {});
      }
    } finally {
      setExporting(false);
    }
  }

  // Chrome/Edge expose the folder API; Brave/Firefox usually don't (they save
  // each file as a normal download instead). We tailor the export hint to that.
  const hasFolderApi =
    typeof (window as any).showDirectoryPicker === "function";

  const selectedCount = useMemo(
    () => mockups.filter((m) => selected.has(m.id)).length,
    [mockups, selected]
  );

  // The size estimate is only valid for the current inputs — clear it when any
  // of them change so a stale number isn't shown.
  useEffect(() => {
    setEstimateMB(null);
  }, [selected, mockups, format, quality, realism, design]);

  // Render the selected mockups and total up their byte size (accurate — it
  // renders exactly what export would produce).
  async function calcSize() {
    if (!design) return;
    const targets = mockups.filter((m) => selected.has(m.id));
    if (!targets.length) return;
    setEstimating(true);
    try {
      const q = QUALITY[quality];
      const mime = format === "jpeg" ? "image/jpeg" : "image/png";
      let total = 0;
      for (const m of targets) {
        const blob = await renderMockup(m, boxesFor(m), design, {
          realism,
          garment: m.tone ?? "light",
          mime,
          quality: q.jpeg,
          outScale: q.scale,
        });
        total += blob.size;
      }
      setEstimateMB(total / (1024 * 1024));
    } finally {
      setEstimating(false);
    }
  }

  const canExport = !!design && selectedCount > 0 && !exporting;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">🎽 Mockup Studio</h1>

        <section className="panel">
          <h2>1 · Design shape</h2>
          <div className="shape-tabs">
            {SHAPE_KEYS.map((k) => (
              <button
                key={k}
                className={"shape-tab" + (shape === k ? " on" : "")}
                onClick={() => setShape(k)}
              >
                {k}
              </button>
            ))}
          </div>
          {autoShapeNote && (
            <p className="auto-note">
              ✨ Auto-picked <b>{autoShapeNote}</b> from your design
            </p>
          )}
          <div className="preset-edit">
            <label>Size (px)</label>
            <div className="dim">
              <input
                type="number"
                value={presets[shape].w}
                disabled={!isOwner}
                onChange={(e) =>
                  updatePreset(shape, { w: Number(e.target.value) || 1 })
                }
              />
              <span>×</span>
              <input
                type="number"
                value={presets[shape].h}
                disabled={!isOwner}
                onChange={(e) =>
                  updatePreset(shape, { h: Number(e.target.value) || 1 })
                }
              />
            </div>
            <p className="hint">
              Sets the box aspect ratio for new mockups.
            </p>
          </div>
        </section>

        <section className="panel">
          <h2>2 · Your design</h2>
          <label className="file-btn">
            {design ? "Change design" : "Upload design (PNG)"}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onSetDesign(e.target.files)}
            />
          </label>
          {design && (
            <div className="design-preview">
              <img src={design.src} />
              <span>{design.name}</span>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>3 · Realism</h2>
          <label className="slider">
            <span className="slider-head">
              Print into fabric <b>{Math.round(realism * 100)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={realism}
              disabled={!isOwner}
              onChange={(e) => setRealism(Number(e.target.value))}
            />
          </label>
          <div className="scale-legend">
            <span>Sticker</span>
            <span>Printed in</span>
          </div>
          <p className="hint">
            Higher = the design sinks into the shirt so wrinkles and shadows show
            through, like real mockup previews.
          </p>
        </section>

        <section className="panel">
          <h2>4 · Export</h2>
          <label className="field-label">Format</label>
          <div className="shape-tabs">
            {(["jpeg", "png"] as const).map((fmt) => (
              <button
                key={fmt}
                className={"shape-tab" + (format === fmt ? " on" : "")}
                onClick={() => setFormat(fmt)}
              >
                {fmt === "jpeg" ? "JPG" : "PNG"}
              </button>
            ))}
          </div>
          <label className="field-label">Quality</label>
          <div className="shape-tabs">
            {(["low", "medium", "high"] as const).map((qk) => (
              <button
                key={qk}
                className={"shape-tab" + (quality === qk ? " on" : "")}
                onClick={() => setQuality(qk)}
              >
                {qk}
              </button>
            ))}
          </div>
          <label className="field-label">File name</label>
          <div className="name-row">
            <input
              type="text"
              value={groupName}
              placeholder="group"
              onChange={(e) => setGroupName(e.target.value)}
            />
            <span className="name-preview">
              {(groupName.trim() || "group")}-1.{format === "jpeg" ? "jpg" : "png"}
            </span>
          </div>
          <div className="size-row">
            <button
              className="mini"
              disabled={!design || selectedCount === 0 || estimating}
              onClick={calcSize}
            >
              {estimating ? "Calculating…" : "Estimate size"}
            </button>
            <span className="size-out">
              {estimateMB == null
                ? `${selectedCount} image${selectedCount === 1 ? "" : "s"}`
                : `≈ ${estimateMB.toFixed(estimateMB < 10 ? 2 : 1)} MB total`}
            </span>
          </div>
          <button
            className="primary"
            disabled={!canExport}
            onClick={exportSelected}
          >
            {exporting
              ? "Rendering…"
              : hasFolderApi
              ? `Choose folder & save ${selectedCount} image${
                  selectedCount === 1 ? "" : "s"
                }`
              : `Download ${selectedCount} image${
                  selectedCount === 1 ? "" : "s"
                }`}
          </button>
          {hasFolderApi ? (
            <p className="hint">
              Pick a folder once — all ticked mockups save straight into it as
              numbered {format === "jpeg" ? "JPGs" : "PNGs"} (<b>{(groupName.trim() || "group")}-1</b>,{" "}
              <b>-2</b>, …). No zip, no one-by-one prompts.
            </p>
          ) : (
            <p className="hint">
              Your browser can't save to a chosen folder, so multiple images come
              down as a single <b>{(groupName.trim() || "group")}.zip</b> (one
              prompt, not one per image). Open this app in <b>Chrome or Edge</b> to
              instead pick a folder once and get the images as individual{" "}
              {format === "jpeg" ? "JPGs" : "PNGs"}.
            </p>
          )}
        </section>
      </aside>

      <main className="main">
        <div className="toolbar">
          {isOwner && (
            <label className="file-btn add-btn">
              ＋ Add mockups
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => onAddMockups(e.target.files)}
              />
            </label>
          )}
          {mockups.length > 0 && (
            <button
              className="mini auto-btn"
              disabled={autoBusy}
              onClick={autoPlaceAll}
              title="Detect the shirt in every photo and place the design on it"
            >
              {autoBusy ? "Placing…" : "✨ Auto-place all"}
            </button>
          )}
          {mockups.length > 0 && (
            <div className="tone-filter">
              <button
                className={"mini" + (brandFilter === "all" ? " on" : "")}
                onClick={() => setBrandFilter("all")}
              >
                All brands
              </button>
              {BRANDS.map((b) => (
                <button
                  key={b}
                  className={"mini" + (brandFilter === b ? " on" : "")}
                  onClick={() => setBrandFilter(b)}
                >
                  👕 {b === "Comfort Colors" ? "CC" : b}
                </button>
              ))}
            </div>
          )}
          {mockups.length > 0 && (
            <div className="tone-filter">
              {(["all", "light", "dark"] as const).map((f) => (
                <button
                  key={f}
                  className={"mini" + (toneFilter === f ? " on" : "")}
                  onClick={() => setToneFilter(f)}
                >
                  {f === "all" ? "All" : f === "light" ? "☀ Light" : "🌙 Dark"}
                </button>
              ))}
            </div>
          )}
          {mockups.length > 0 && (
            <span className="chip">{selectedCount} selected</span>
          )}
          <span className="muted hide-sm">
            Drag to move · corner resizes · outside a corner rotates.
          </span>
        </div>

        {mockups.length === 0 ? (
          <div className="empty">
            <p>No mockups yet.</p>
            <p className="muted">
              {isOwner
                ? "Click + Add mockups and upload your blank shirt photos."
                : "No mockups in your team's library yet. Ask an owner to add some."}
            </p>
          </div>
        ) : (
          BRANDS.filter(
            (brand) =>
              (brandFilter === "all" || brandFilter === brand) &&
              mockups.some((m) => (m.brand ?? DEFAULT_BRAND) === brand)
          ).map((brand) => {
            const brandMockups = mockups.filter(
              (m) => (m.brand ?? DEFAULT_BRAND) === brand
            );
            return (
              <section className="brand-group" key={brand}>
                <h2 className="brand-head">
                  👕 {brand}
                  <span className="chip">{brandMockups.length}</span>
                </h2>
                {(["light", "dark"] as const)
                  .filter((tone) => toneFilter === "all" || toneFilter === tone)
                  .map((tone) => {
                    const group = brandMockups.filter(
                      (m) => (m.tone ?? "light") === tone
                    );
                    return (
                      <section className="tone-group" key={tone}>
                        <div className="tone-head">
                          <span className={"swatch " + tone} />
                          <h3>
                            {tone === "light" ? "Light color" : "Dark color"} mockups
                          </h3>
                          <span className="chip">{group.length}</span>
                          {group.length > 0 && (
                            <div className="tone-select">
                              <button
                                className="mini"
                                onClick={() =>
                                  setGroupSelected(group.map((m) => m.id), true)
                                }
                              >
                                Select all
                              </button>
                              <button
                                className="mini"
                                onClick={() =>
                                  setGroupSelected(group.map((m) => m.id), false)
                                }
                              >
                                None
                              </button>
                            </div>
                          )}
                        </div>
                        {group.length === 0 ? (
                          <p className="muted tone-empty">
                            None yet — use the ☀ / 🌙 toggle on a mockup to move it here.
                          </p>
                        ) : (
                          <div className="grid">
                            {group.map((m) => (
                              <MockupCard
                                key={m.id}
                                mockup={m}
                                shape={shape}
                                boxes={boxesFor(m)}
                                design={design}
                                realism={realism}
                                garment={m.tone ?? "light"}
                                selected={selected.has(m.id)}
                                hasMany={mockups.length > 1}
                                autoBusy={autoBusy}
                                onChangeBoxes={(boxes) => updateBoxes(m.id, boxes)}
                                onAddBox={() => addBox(m.id)}
                                onRemoveBox={(i) => removeBox(m.id, i)}
                                onApplyToAll={() => applyLayoutToAll(m.id)}
                                onAutoPlace={() => autoPlaceCard(m.id)}
                                onSetTone={(t) => setTone(m.id, t)}
                                onSetBrand={(b) => setBrand(m.id, b)}
                                onCopy={() => copyMockup(m.id)}
                                onToggleSelect={() => toggleSelect(m.id)}
                                onPickShape={setShape}
                                onToggleLock={() => toggleLock(m.id)}
                                onRemove={() => removeMockup(m.id)}
                                isOwner={isOwner}
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
              </section>
            );
          })
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

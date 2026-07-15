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
} from "./render";
import { detectShirtBoxes } from "./autoplace";
import MockupCard from "./components/MockupCard";

const uid = () => Math.random().toString(36).slice(2, 9);

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
  const [groupName, setGroupName] = useState("mockup");
  const [exporting, setExporting] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  // Which mockups are ticked for export. New mockups start selected.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [autoShapeNote, setAutoShapeNote] = useState<ShapeKey | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
      setMockups(s.mockups);
      setPresets(s.presets);
      setDesign(s.design);
      setShape(s.settings.shape);
      setRealism(s.settings.realism);
      setGroupName(s.settings.groupName);
      setSelected(new Set(s.mockups.map((m) => m.id)));
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the latest state in a ref so we can flush it synchronously on close.
  const latest = useRef({ mockups, presets, design, shape, realism, groupName });
  latest.current = { mockups, presets, design, shape, realism, groupName };
  const flush = () => {
    if (!loaded.current) return;
    const l = latest.current;
    saveState({
      mockups: l.mockups,
      presets: l.presets,
      design: l.design,
      settings: {
        shape: l.shape,
        realism: l.realism,
        groupName: l.groupName,
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
  }, [mockups, presets, design, shape, realism, groupName]);

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
    setMockups((list) => list.filter((m) => m.id !== id));
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  // Lock freezes all placements. When locking, fill in any shape the user
  // hasn't placed yet with its default box, so all three are saved concretely.
  function toggleLock(id: string) {
    setMockups((list) =>
      list.map((m) => {
        if (m.id !== id) return m;
        const willLock = !m.locked;
        let placements = m.placements;
        if (willLock) {
          placements = { ...m.placements };
          for (const k of SHAPE_KEYS) {
            if (!placements[k]?.length)
              placements[k] = [defaultBox(m, presets[k])];
          }
        }
        return { ...m, locked: willLock, placements };
      })
    );
  }

  function setTone(id: string, tone: "light" | "dark") {
    setMockups((list) => list.map((m) => (m.id === id ? { ...m, tone } : m)));
  }

  function setBrand(id: string, brand: Brand) {
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
    const base = (groupName.trim() || "mockup").replace(/[\\/:*?"<>|]+/g, "-");
    const pad = String(targets.length).length;

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
          mime: "image/png",
        });
        i += 1;
        files.push({
          name: `${base}-${String(i).padStart(pad, "0")}.png`,
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
      } else {
        for (const f of files) {
          downloadBlob(f.blob, f.name);
          await delay(120);
        }
        flash(`Sent ${files.length} images to Downloads ✓`);
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
                onChange={(e) =>
                  updatePreset(shape, { w: Number(e.target.value) || 1 })
                }
              />
              <span>×</span>
              <input
                type="number"
                value={presets[shape].h}
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
          <label className="field-label">File name</label>
          <div className="name-row">
            <input
              type="text"
              value={groupName}
              placeholder="mockup"
              onChange={(e) => setGroupName(e.target.value)}
            />
            <span className="name-preview">
              {(groupName.trim() || "mockup")}-1.png
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
              numbered PNGs (<b>{(groupName.trim() || "mockup")}-1</b>,{" "}
              <b>-2</b>, …). No zip, no one-by-one prompts.
            </p>
          ) : (
            <p className="hint">
              Saved as numbered PNGs (<b>{(groupName.trim() || "mockup")}-1</b>,{" "}
              <b>-2</b>, …) — no zip. Your browser (Brave/Firefox) downloads them
              individually. To make them all land in Downloads at once like
              Figma, turn off <b>“Ask where to save each file before
              downloading”</b> in your browser’s download settings — or open this
              app in Chrome/Edge to pick one folder.
            </p>
          )}
        </section>
      </aside>

      <main className="main">
        <div className="toolbar">
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
              Click <b>+ Add mockups</b> and upload your blank shirt photos.
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

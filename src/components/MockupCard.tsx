import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Box, DesignAsset, DesignFrame, Mockup, ShapeKey } from "../types";
import { SHAPE_KEYS } from "../types";
import { compositeDesignBox, loadImageCached, type Garment } from "../composite";

// Canvas layer that renders the design into every box with displacement +
// fabric shading, so the on-screen preview matches the exported image.
function DesignCanvas({
  mockupSrc,
  design,
  frame,
  boxes,
  scale,
  width,
  height,
  realism,
  garment,
}: {
  mockupSrc: string;
  design: DesignAsset;
  frame: DesignFrame;
  boxes: Box[];
  scale: number;
  width: number;
  height: number;
  realism: number;
  garment: Garment;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxKey = JSON.stringify(boxes);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelW = Math.max(1, Math.round(width * dpr));
  const pixelH = Math.max(1, Math.round(height * dpr));
  useEffect(() => {
    let cancelled = false;
    const cv = ref.current;
    if (!cv) return;
    Promise.all([loadImageCached(mockupSrc), loadImageCached(design.src)]).then(
      ([mk, art]) => {
        if (cancelled || !ref.current) return;
        const ctx = ref.current.getContext("2d")!;
        ctx.clearRect(0, 0, pixelW, pixelH);
        for (const b of boxes) {
          const tb: Box = {
            x: b.x * scale * dpr,
            y: b.y * scale * dpr,
            w: b.w * scale * dpr,
            h: b.h * scale * dpr,
            rotation: b.rotation ?? 0,
          };
          compositeDesignBox(ctx, mk, pixelW, pixelH, art, tb, realism, garment, frame);
        }
      }
    );
    return () => {
      cancelled = true;
    };
    // boxKey captures box geometry changes (drag/resize/rotate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupSrc, design.src, boxKey, scale, pixelW, pixelH, dpr, realism, garment, frame.x, frame.y, frame.zoom]);

  return (
    <canvas
      ref={ref}
      width={pixelW}
      height={pixelH}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

interface Props {
  mockup: Mockup;
  shape: ShapeKey;
  boxes: Box[]; // current placement boxes for the active shape
  design: DesignAsset | null;
  frame: DesignFrame;
  realism: number; // 0..1 — how much the print sinks into the fabric
  garment: Garment; // light vs dark garment tone
  selected: boolean;
  hasMany: boolean; // are there other mockups to apply the layout to?
  autoBusy: boolean;
  onChangeBoxes: (boxes: Box[]) => void;
  onAddBox: () => void;
  onRemoveBox: (index: number) => void;
  onApplyToAll: () => void;
  onAutoPlace: () => void;
  onSetTone: (tone: Garment) => void;
  allCategories: string[];
  onToggleCategory: (cat: string) => void;
  onCopy: () => void;
  onToggleSelect: () => void;
  onPickShape: (shape: ShapeKey) => void;
  onToggleLock: () => void;
  onRemove: () => void;
  isOwner: boolean; // members are read-only: no add/remove/tone/brand/lock
}

type DragMode = null | "move" | "resize" | "rotate";

export default function MockupCard({
  mockup,
  shape,
  boxes,
  design,
  frame,
  realism,
  garment,
  selected,
  hasMany,
  autoBusy,
  onChangeBoxes,
  onAddBox,
  onRemoveBox,
  onApplyToAll,
  onAutoPlace,
  onSetTone,
  allCategories,
  onToggleCategory,
  onCopy,
  onToggleSelect,
  onPickShape,
  onToggleLock,
  onRemove,
  isOwner,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // The stage now fills the card, so we measure its real width and derive the
  // scale from that (instead of a hard-coded 300px that mismatched the card).
  const [stageW, setStageW] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setStageW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = stageW ? stageW / mockup.width : 0;
  const displayH = mockup.height * scale;

  const drag = useRef<{
    idx: number;
    mode: DragMode;
    startX: number;
    startY: number;
    orig: Box;
    startAngle: number; // pointer angle (deg) at grab, for rotate
  } | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  // Deselect the active box when this mockup gets locked.
  useEffect(() => {
    if (mockup.locked) setActiveIdx(null);
  }, [mockup.locked]);

  const locked = !!mockup.locked;

  function toImgCoords(clientX: number, clientY: number) {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }

  function onPointerDown(idx: number, mode: DragMode, e: React.PointerEvent) {
    if (locked) return; // frozen — no editing
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const box = boxes[idx];
    let startAngle = 0;
    if (mode === "rotate") {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const p = toImgCoords(e.clientX, e.clientY);
      startAngle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
    }
    drag.current = {
      idx,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      orig: box,
      startAngle,
    };
    setActiveIdx(idx);
  }

  function commit(idx: number, box: Box) {
    onChangeBoxes(boxes.map((b, i) => (i === idx ? box : b)));
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || !scale) return;
    const { idx, orig: o } = drag.current;
    const dx = (e.clientX - drag.current.startX) / scale;
    const dy = (e.clientY - drag.current.startY) / scale;

    if (drag.current.mode === "move") {
      let nx = o.x + dx;
      let ny = o.y + dy;
      nx = Math.max(0, Math.min(nx, mockup.width - o.w));
      ny = Math.max(0, Math.min(ny, mockup.height - o.h));
      commit(idx, { ...o, x: nx, y: ny });
    } else if (drag.current.mode === "resize") {
      const ratio = o.w / o.h;
      let nw = Math.max(40, o.w + dx);
      let nh = nw / ratio;
      if (o.x + nw > mockup.width) {
        nw = mockup.width - o.x;
        nh = nw / ratio;
      }
      if (o.y + nh > mockup.height) {
        nh = mockup.height - o.y;
        nw = nh * ratio;
      }
      commit(idx, { ...o, w: nw, h: nh });
    } else if (drag.current.mode === "rotate") {
      // Rotate by the change in pointer angle since grab — so it tracks the
      // corner you actually grabbed, with no jump.
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const p = toImgCoords(e.clientX, e.clientY);
      const cur = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
      let ang = (o.rotation ?? 0) + (cur - drag.current.startAngle);
      // normalize to -180..180
      ang = ((((ang + 180) % 360) + 360) % 360) - 180;
      // snap near straight angles
      for (const t of [-180, -90, 0, 90, 180]) {
        if (Math.abs(ang - t) < 3) ang = t;
      }
      commit(idx, { ...o, rotation: Math.round(ang) });
    }
  }

  function onPointerUp() {
    drag.current = null;
  }

  // The whole card is the select control: clicking it toggles export selection,
  // except when the click lands on a button, an input, or the stage (where you
  // drag/resize/rotate the placement box).
  function onCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button, input, .stage")) return;
    onToggleSelect();
  }

  return (
    <div
      className={"card" + (selected ? " sel" : "") + (locked ? " locked" : "")}
      onClick={onCardClick}
      title={selected ? "Selected — click to exclude from export" : "Click to include in export"}
    >
      <div className="card-head">
        <div className="sel-check">
          <span className={"sel-box" + (selected ? " on" : "")}>
            {selected ? "✓" : ""}
          </span>
          <span className="card-name" title={mockup.name}>
            {mockup.name}
          </span>
        </div>
        <div className="head-actions">
          {isOwner && (
            <button
              className="tone-btn"
              onClick={() => onSetTone(garment === "light" ? "dark" : "light")}
              title={`This mockup is ${garment} — click to move it to the ${
                garment === "light" ? "Dark" : "Light"
              } group`}
            >
              {garment === "light" ? "☀" : "🌙"}
            </button>
          )}
          <button
            className="tone-btn"
            onClick={onCopy}
            disabled={!design}
            title="Copy this finished mockup image to the clipboard"
          >
            ⧉
          </button>
          <button
            className={"tone-btn" + (locked ? " lock-on" : "")}
            onClick={onToggleLock}
            disabled={!isOwner}
            title={
              !isOwner
                ? "Only an owner can lock/unlock"
                : locked
                ? "Unlock to edit placements"
                : "Lock all placements"
            }
          >
            {locked ? "🔒" : "🔓"}
          </button>
          {isOwner && (
            <button className="icon-btn" onClick={onRemove} title="Remove mockup">
              ✕
            </button>
          )}
        </div>
      </div>

      {!locked && (
      <div className="shape-badges">
        {SHAPE_KEYS.map((k) => {
          const placed = !!mockup.placements[k]?.length;
          return (
            <button
              key={k}
              className={
                "badge" +
                (k === shape ? " on" : "") +
                (placed ? " placed" : "")
              }
              onClick={() => onPickShape(k)}
              title={`Edit ${k} placement`}
            >
              {placed ? "●" : "○"} {k}
            </button>
          );
        })}
      </div>
      )}

      <div className="cat-row">
        {isOwner
          ? allCategories.map((cat) => (
              <button
                key={cat}
                className={
                  "cat-chip" +
                  (mockup.categories?.includes(cat) ? " on" : "")
                }
                onClick={() => onToggleCategory(cat)}
                title={
                  mockup.categories?.includes(cat)
                    ? `Remove from ${cat}`
                    : `Add to ${cat}`
                }
              >
                {cat}
              </button>
            ))
          : (mockup.categories ?? []).map((cat) => (
              <span key={cat} className="cat-chip on">
                {cat}
              </span>
            ))}
      </div>

      <div
        ref={wrapRef}
        className="stage"
        style={{ aspectRatio: `${mockup.width} / ${mockup.height}` }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <img
          className="mockup-img"
          src={mockup.thumbSrc || mockup.src}
          crossOrigin={mockup.src.startsWith("data:") ? undefined : "anonymous"}
          loading="lazy"
          decoding="async"
          draggable={false}
        />

        {design && scale > 0 && (
          <DesignCanvas
            mockupSrc={mockup.src}
            design={design}
            frame={frame}
            boxes={boxes}
            scale={scale}
            width={stageW}
            height={displayH}
            realism={realism}
            garment={garment}
          />
        )}

        {scale > 0 &&
          boxes.map((box, idx) => {
            const rot = box.rotation ?? 0;
            const isActive = activeIdx === idx;
            return (
              <div key={idx} className="box-layer">
                <div
                  className={
                    "place-box" +
                    (isActive ? " active" : "") +
                    (locked ? " frozen" : "")
                  }
                  style={{
                    left: box.x * scale,
                    top: box.y * scale,
                    width: box.w * scale,
                    height: box.h * scale,
                    transform: `rotate(${rot}deg)`,
                    transformOrigin: "center center",
                  }}
                  onPointerDown={(e) => onPointerDown(idx, "move", e)}
                >
                  {boxes.length > 1 && (
                    <span className="box-tag">{idx + 1}</span>
                  )}
                  {!locked && (
                    <>
                      {/* Photoshop-style: hovering just outside a corner shows
                          the rotate cursor; dragging there rotates. */}
                      <div
                        className="rot-zone tl"
                        onPointerDown={(e) => onPointerDown(idx, "rotate", e)}
                      />
                      <div
                        className="rot-zone tr"
                        onPointerDown={(e) => onPointerDown(idx, "rotate", e)}
                      />
                      <div
                        className="rot-zone bl"
                        onPointerDown={(e) => onPointerDown(idx, "rotate", e)}
                      />
                      <div
                        className="rot-zone br"
                        onPointerDown={(e) => onPointerDown(idx, "rotate", e)}
                      />
                      <div
                        className="resize-handle"
                        title="Resize"
                        onPointerDown={(e) => onPointerDown(idx, "resize", e)}
                      />
                      {boxes.length > 1 && (
                        <button
                          className="box-del"
                          title="Remove this spot"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onRemoveBox(idx)}
                        >
                          ✕
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {!locked && (
        <div className="card-tools">
          <button
            className="mini auto"
            disabled={autoBusy || !design}
            onClick={onAutoPlace}
            title="Auto-detect the shirt(s) in this photo and place the design"
          >
            ✨ Auto
          </button>
          <button
            className="mini"
            onClick={onAddBox}
            title="Add another spot for this shape (e.g. a second shirt)"
          >
            ＋ Spot
          </button>
          <button
            className="mini"
            disabled={!hasMany}
            onClick={onApplyToAll}
            title="Copy this layout to every other mockup for this shape"
          >
            ⇄ To all
          </button>
        </div>
      )}
    </div>
  );
}

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { DesignAsset, ShapeKey, ShapePreset, DesignFrame } from "../types";
import { SHAPE_KEYS, DEFAULT_DESIGN_FRAME } from "../types";

interface StudioPanelProps {
  title: string;
  design: DesignAsset;
  shape: ShapeKey;
  onPickShape: (s: ShapeKey) => void;
  presets: Record<ShapeKey, ShapePreset>;
  frameFor: (s: ShapeKey) => DesignFrame;
  updateFrame: (s: ShapeKey, patch: Partial<DesignFrame>) => void;
}

function StudioPanel({
  title,
  design,
  shape,
  onPickShape,
  presets,
  frameFor,
  updateFrame,
}: StudioPanelProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const availW = el.clientWidth;
      const availH = el.clientHeight;
      if (!availW || !availH) return;
      const ratio = presets[shape].w / presets[shape].h;
      let w = availW;
      let h = w / ratio;
      if (h > availH) {
        h = availH;
        w = h * ratio;
      }
      setBox({ w: Math.round(w), h: Math.round(h) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [shape, presets]);

  const fr = frameFor(shape);
  const artRatio = design.width / design.height;
  const boxRatio = presets[shape].w / presets[shape].h;
  let wPct: number;
  let hPct: number;
  if (boxRatio > artRatio) {
    wPct = 100;
    hPct = 100 * (boxRatio / artRatio);
  } else {
    hPct = 100;
    wPct = 100 * (artRatio / boxRatio);
  }
  wPct *= fr.zoom;
  hPct *= fr.zoom;
  const zoomProgress = ((fr.zoom - 0.3) / (3 - 0.3)) * 100;

  return (
    <section className="studio-panel">
      <div className="studio-panel-head">
        <h3>{title}</h3>
        <span>{design.name}</span>
      </div>
      <div className="studio-shapes studio-panel-shapes">
        {SHAPE_KEYS.map((k) => (
          <button
            key={k}
            className={`shape-tab${shape === k ? " on" : ""}`}
            onClick={() => onPickShape(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="studio-stage" ref={stageRef}>
        {box && (
          <div
            className="studio-box"
            style={{ width: box.w, height: box.h }}
            onPointerDown={(e) => {
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const rect = el.getBoundingClientRect();
              const startX = e.clientX;
              const startY = e.clientY;
              const f0 = frameFor(shape);
              const move = (ev: PointerEvent) => {
                const dx = (ev.clientX - startX) / rect.width;
                const dy = (ev.clientY - startY) / rect.height;
                updateFrame(shape, {
                  x: Math.max(-2, Math.min(2, f0.x + dx)),
                  y: Math.max(-2, Math.min(2, f0.y + dy)),
                });
              };
              const up = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", up);
                el.removeEventListener("pointercancel", up);
              };
              el.addEventListener("pointermove", move);
              el.addEventListener("pointerup", up);
              el.addEventListener("pointercancel", up);
            }}
          >
            <img
              src={design.src}
              alt={`${title} artwork`}
              draggable={false}
              style={{
                position: "absolute",
                width: `${wPct}%`,
                height: `${hPct}%`,
                left: `${(100 - wPct) / 2 + fr.x * 100}%`,
                top: `${(100 - hPct) / 2 + fr.y * 100}%`,
              }}
            />
          </div>
        )}
      </div>

      <label className="slider studio-zoom">
        <span className="slider-head">
          Zoom <b>{Math.round(fr.zoom * 100)}%</b>
        </span>
        <input
          type="range"
          min={0.3}
          max={3}
          step={0.01}
          value={fr.zoom}
          aria-label={`${title} zoom`}
          style={{ "--range-progress": `${zoomProgress}%` } as CSSProperties}
          onChange={(e) => updateFrame(shape, { zoom: Number(e.target.value) })}
        />
      </label>

      <div className="studio-actions">
        <button className="mini" onClick={() => updateFrame(shape, { x: 0 })}>
          ⇔ Center H
        </button>
        <button className="mini" onClick={() => updateFrame(shape, { y: 0 })}>
          ⇕ Center V
        </button>
        <button
          className="mini"
          onClick={() => updateFrame(shape, { ...DEFAULT_DESIGN_FRAME })}
        >
          Reset
        </button>
      </div>
    </section>
  );
}

// One-sided uploads show one editor. Two-sided uploads show independent front
// and back editors in the same modal so each design keeps its own pan and zoom.
export default function DesignStudio({
  design,
  backDesign,
  frontShape,
  backShape,
  onPickFrontShape,
  onPickBackShape,
  presets,
  frameFor,
  updateFrame,
  backFrameFor,
  updateBackFrame,
  onClose,
}: {
  design: DesignAsset;
  backDesign?: DesignAsset | null;
  frontShape: ShapeKey;
  backShape?: ShapeKey;
  onPickFrontShape: (s: ShapeKey) => void;
  onPickBackShape?: (s: ShapeKey) => void;
  presets: Record<ShapeKey, ShapePreset>;
  frameFor: (s: ShapeKey) => DesignFrame;
  updateFrame: (s: ShapeKey, patch: Partial<DesignFrame>) => void;
  backFrameFor?: (s: ShapeKey) => DesignFrame;
  updateBackFrame?: (s: ShapeKey, patch: Partial<DesignFrame>) => void;
  onClose: () => void;
}) {
  const dual = Boolean(backDesign && backFrameFor && updateBackFrame);

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className={`studio-modal${dual ? " studio-modal-dual" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{dual ? "Front & back studios" : "Design studio"}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className={`studio-panels${dual ? " dual" : ""}`}>
          <StudioPanel
            title={dual ? "Front · 1.png" : "Design"}
            design={design}
            shape={frontShape}
            onPickShape={onPickFrontShape}
            presets={presets}
            frameFor={frameFor}
            updateFrame={updateFrame}
          />
          {dual && backDesign && backShape && onPickBackShape && backFrameFor && updateBackFrame && (
            <StudioPanel
              title="Back · 2.png"
              design={backDesign}
              shape={backShape}
              onPickShape={onPickBackShape}
              presets={presets}
              frameFor={backFrameFor}
              updateFrame={updateBackFrame}
            />
          )}
        </div>

        <div className="studio-footer">
          <p className="hint">
            Drag and zoom {dual ? "each design independently" : "the design"}.
            These settings are used in previews and exports.
          </p>
          <button className="auth-primary studio-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

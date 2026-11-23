import React, { useEffect, useMemo, useRef } from 'react';
import type { AuditBoundingBox, AuditFinding, AuditPriority } from '../types/audit';

export interface IndexedOverlayFinding {
  finding: AuditFinding;
  index: number;
}

interface PdfFindingsOverlayCanvasProps {
  width: number;
  height: number;
  rotation: number;
  pageNumber: number;
  findings: IndexedOverlayFinding[];
  activeFindingId: string | null;
  hoveredFindingId: string | null;
  onHoverFinding: (findingId: string | null) => void;
  onSelectFinding: (finding: AuditFinding | null) => void;
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ComputedMarker {
  finding: AuditFinding;
  index: number;
  label: string;
  rect: PixelRect;
  badgeRect: PixelRect;
}

const PRIORITY_COLORS: Record<
  AuditPriority,
  { stroke: string; fill: string; activeFill: string; badgeBg: string; halo: string }
> = {
  P0: {
    stroke: '#DC2626',
    fill: 'rgba(220, 38, 38, 0.13)',
    activeFill: 'rgba(220, 38, 38, 0.24)',
    badgeBg: '#B91C1C',
    halo: 'rgba(220, 38, 38, 0.32)',
  },
  P1: {
    stroke: '#EA580C',
    fill: 'rgba(234, 88, 12, 0.12)',
    activeFill: 'rgba(234, 88, 12, 0.22)',
    badgeBg: '#C2410C',
    halo: 'rgba(234, 88, 12, 0.30)',
  },
  P2: {
    stroke: '#D97706',
    fill: 'rgba(217, 119, 6, 0.12)',
    activeFill: 'rgba(217, 119, 6, 0.22)',
    badgeBg: '#B45309',
    halo: 'rgba(217, 119, 6, 0.28)',
  },
  P3: {
    stroke: '#334155',
    fill: 'rgba(51, 65, 85, 0.11)',
    activeFill: 'rgba(51, 65, 85, 0.21)',
    badgeBg: '#1E293B',
    halo: 'rgba(51, 65, 85, 0.28)',
  },
};

/**
 * Transform normalized [0..1000] unrotated page coordinates into pixel coordinates
 * for the current clockwise page rotation (0, 90, 180, 270 degrees).
 */
export function transformBoundingBoxToPixels(
  box: AuditBoundingBox,
  width: number,
  height: number,
  rotation: number,
): PixelRect {
  const normRot = ((rotation % 360) + 360) % 360;
  let rXmin = box.xmin;
  let rXmax = box.xmax;
  let rYmin = box.ymin;
  let rYmax = box.ymax;

  if (normRot === 90) {
    rXmin = 1000 - box.ymax;
    rXmax = 1000 - box.ymin;
    rYmin = box.xmin;
    rYmax = box.xmax;
  } else if (normRot === 180) {
    rXmin = 1000 - box.xmax;
    rXmax = 1000 - box.xmin;
    rYmin = 1000 - box.ymax;
    rYmax = 1000 - box.ymin;
  } else if (normRot === 270) {
    rXmin = box.ymin;
    rXmax = box.ymax;
    rYmin = 1000 - box.xmax;
    rYmax = 1000 - box.xmin;
  }

  const x = (rXmin / 1000) * width;
  const y = (rYmin / 1000) * height;
  const w = Math.max(12, ((rXmax - rXmin) / 1000) * width);
  const h = Math.max(12, ((rYmax - rYmin) / 1000) * height);

  return {
    x: Math.max(1, Math.min(width - w - 1, x)),
    y: Math.max(1, Math.min(height - h - 1, y)),
    w: Math.min(w, Math.max(12, width - 2)),
    h: Math.min(h, Math.max(12, height - 2)),
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function pointInRect(px: number, py: number, r: PixelRect, pad = 0): boolean {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}

export const PdfFindingsOverlayCanvas: React.FC<PdfFindingsOverlayCanvasProps> = ({
  width,
  height,
  rotation,
  pageNumber,
  findings,
  activeFindingId,
  hoveredFindingId,
  onHoverFinding,
  onSelectFinding,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const markers = useMemo<ComputedMarker[]>(() => {
    const result: ComputedMarker[] = [];
    for (const item of findings) {
      if (!item.finding.boundingBox) continue;
      const rect = transformBoundingBoxToPixels(item.finding.boundingBox, width, height, rotation);
      const label = `${item.finding.priority} #${item.index}`;
      const badgeW = Math.max(44, label.length * 6.8 + 12);
      const badgeH = 18;
      const bx = Math.max(2, Math.min(width - badgeW - 2, rect.x));
      const by = rect.y >= badgeH + 3 ? rect.y - badgeH - 2 : Math.min(height - badgeH - 2, rect.y + 2);

      result.push({
        finding: item.finding,
        index: item.index,
        label,
        rect,
        badgeRect: { x: bx, y: by, w: badgeW, h: badgeH },
      });
    }
    return result;
  }, [findings, width, height, rotation]);

  // Render high-DPR canvas markers whenever dimensions, rotation, findings, or focus state change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (markers.length === 0) return;

    const hasActiveOnPage = Boolean(
      activeFindingId && markers.some((m) => m.finding.id === activeFindingId),
    );

    // Paint order: base markers -> hovered marker -> active selected marker on top
    const ordered = [...markers].sort((a, b) => {
      const score = (m: ComputedMarker) => {
        if (m.finding.id === activeFindingId) return 2;
        if (m.finding.id === hoveredFindingId) return 1;
        return 0;
      };
      return score(a) - score(b);
    });

    for (const marker of ordered) {
      const { finding, rect, badgeRect, label } = marker;
      const colors = PRIORITY_COLORS[finding.priority];
      const isActive = finding.id === activeFindingId;
      const isHovered = finding.id === hoveredFindingId;

      ctx.save();
      if (hasActiveOnPage && !isActive && !isHovered) {
        ctx.globalAlpha = 0.42;
      }

      // Outer focus halo for active or hovered marker
      if (isActive || isHovered) {
        ctx.strokeStyle = colors.halo;
        ctx.lineWidth = isActive ? 7 : 4.5;
        drawRoundedRect(ctx, rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2, 4);
        ctx.stroke();
      }

      // Translucent highlight fill
      ctx.fillStyle = isActive || isHovered ? colors.activeFill : colors.fill;
      drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 3);
      ctx.fill();

      // Inner white hairline for contrast against dark CAD geometry
      if (isActive) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 3.5;
        drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 3);
        ctx.stroke();
      }

      // Primary priority border
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = isActive ? 2.25 : isHovered ? 2 : 1.5;
      if (!isActive && !isHovered) {
        ctx.setLineDash([5, 3]);
      } else {
        ctx.setLineDash([]);
      }
      drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 3);
      ctx.stroke();
      ctx.setLineDash([]);

      // Engineering corner reticle brackets on active selection
      if (isActive) {
        const arm = Math.min(10, Math.max(5, Math.min(rect.w, rect.h) * 0.25));
        const pad = 3.5;
        ctx.strokeStyle = colors.stroke;
        ctx.lineWidth = 2.25;
        ctx.lineCap = 'square';
        ctx.beginPath();
        // Top-left
        ctx.moveTo(rect.x - pad, rect.y - pad + arm);
        ctx.lineTo(rect.x - pad, rect.y - pad);
        ctx.lineTo(rect.x - pad + arm, rect.y - pad);
        // Top-right
        ctx.moveTo(rect.x + rect.w + pad - arm, rect.y - pad);
        ctx.lineTo(rect.x + rect.w + pad, rect.y - pad);
        ctx.lineTo(rect.x + rect.w + pad, rect.y - pad + arm);
        // Bottom-right
        ctx.moveTo(rect.x + rect.w + pad, rect.y + rect.h + pad - arm);
        ctx.lineTo(rect.x + rect.w + pad, rect.y + rect.h + pad);
        ctx.lineTo(rect.x + rect.w + pad - arm, rect.y + rect.h + pad);
        // Bottom-left
        ctx.moveTo(rect.x - pad + arm, rect.y + rect.h + pad);
        ctx.lineTo(rect.x - pad, rect.y + rect.h + pad);
        ctx.lineTo(rect.x - pad, rect.y + rect.h + pad - arm);
        ctx.stroke();
      }

      // Coordinate-aware callout tag (e.g., "P0 #1")
      ctx.fillStyle = colors.badgeBg;
      drawRoundedRect(ctx, badgeRect.x, badgeRect.y, badgeRect.w, badgeRect.h, 3);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 1;
      drawRoundedRect(ctx, badgeRect.x, badgeRect.y, badgeRect.w, badgeRect.h, 3);
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 10.5px "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(label, badgeRect.x + badgeRect.w / 2, badgeRect.y + badgeRect.h / 2 + 0.5);

      ctx.restore();
    }
  }, [markers, width, height, activeFindingId, hoveredFindingId]);

  const hitTest = (clientX: number, clientY: number): ComputedMarker | null => {
    const canvas = canvasRef.current;
    if (!canvas || markers.length === 0) return null;
    const bounds = canvas.getBoundingClientRect();
    const px = clientX - bounds.left;
    const py = clientY - bounds.top;

    // 1. Prefer direct hit on a callout tag first (always unobstructed & intentional)
    for (let i = markers.length - 1; i >= 0; i -= 1) {
      if (pointInRect(px, py, markers[i].badgeRect, 2)) {
        return markers[i];
      }
    }

    // 2. Otherwise pick the smallest matching bounding box so nested features remain selectable
    const hits = markers.filter((m) => pointInRect(px, py, m.rect, 3));
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    return hits[0];
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(event.clientX, event.clientY);
    const nextId = hit ? hit.finding.id : null;
    if (nextId !== hoveredFindingId) {
      onHoverFinding(nextId);
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(event.clientX, event.clientY);
    if (hit) {
      event.stopPropagation();
      onSelectFinding(hit.finding);
    } else if (activeFindingId) {
      onSelectFinding(null);
    }
  };

  const hoveredMarker = hoveredFindingId
    ? markers.find((m) => m.finding.id === hoveredFindingId) ?? null
    : null;

  const tooltipStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!hoveredMarker) return undefined;
    const tipWidth = 264;
    const left = Math.max(8, Math.min(width - tipWidth - 8, hoveredMarker.rect.x));
    const placeAbove = hoveredMarker.rect.y > 108;
    const top = placeAbove
      ? Math.max(8, hoveredMarker.badgeRect.y - 78)
      : Math.min(height - 86, hoveredMarker.rect.y + hoveredMarker.rect.h + 8);
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${tipWidth}px`,
    };
  }, [hoveredMarker, width, height]);

  return (
    <>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          if (hoveredFindingId) onHoverFinding(null);
        }}
        onClick={handleClick}
        aria-label={`Audit findings overlay for sheet ${pageNumber}`}
        className={`absolute inset-0 w-full h-full ${
          hoveredMarker ? 'cursor-pointer' : 'cursor-default'
        }`}
      />

      {hoveredMarker && tooltipStyle && (
        <div
          role="tooltip"
          style={tooltipStyle}
          className="pointer-events-none absolute z-20 bg-slate-900/95 text-white rounded-lg px-3 py-2 shadow-lg border border-slate-700/80 text-left"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
            <span className="font-semibold text-white">{hoveredMarker.label}</span>
            {hoveredMarker.finding.asmeCitation && (
              <span className="text-sky-300 truncate">{hoveredMarker.finding.asmeCitation}</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-slate-200 truncate">
            {hoveredMarker.finding.location}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-300 leading-snug line-clamp-2">
            {hoveredMarker.finding.description}
          </p>
        </div>
      )}
    </>
  );
};

// The kind icons of canvas boxes (CANVAS_BLOCK_SPEC §9), for the server's own drawing (./svg.ts):
// the browser draws the same lucide icons (recollect/components/docs/editor/canvas/kindIcons.tsx).
//
// Icon data copied from lucide-react 0.553.0 (recollect/node_modules/lucide-react), licensed ISC:
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
// All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use,
// copy, modify, and/or distribute this software for any purpose with or without fee is hereby
// granted, provided that the above copyright notice and this permission notice appear in all copies.
//
// Each icon is drawn on a 24×24 grid: no fill, round caps and joins, stroke 1.75 (as KindIcon).
import type { CanvasKind } from '../canvas';

type IconPart = ['path', { d: string }] | ['circle', { cx: number; cy: number; r: number }] | ['rect', { x: number; y: number; width: number; height: number; rx?: number }] | ['line', { x1: number; y1: number; x2: number; y2: number }] | ['ellipse', { cx: number; cy: number; rx: number; ry: number }];

export const KIND_ICON_PARTS: Readonly<Record<CanvasKind, readonly IconPart[]>> = {
    // Monitor
    client: [
        ['rect', { width: 20, height: 14, x: 2, y: 3, rx: 2 }],
        ['line', { x1: 8, x2: 16, y1: 21, y2: 21 }],
        ['line', { x1: 12, x2: 12, y1: 17, y2: 21 }],
    ],
    // User
    user: [
        ['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 12, cy: 7, r: 4 }],
    ],
    // Smartphone
    mobile: [
        ['rect', { width: 14, height: 20, x: 5, y: 2, rx: 2 }],
        ['path', { d: 'M12 18h.01' }],
    ],
    // Server
    service: [
        ['rect', { width: 20, height: 8, x: 2, y: 2, rx: 2 }],
        ['rect', { width: 20, height: 8, x: 2, y: 14, rx: 2 }],
        ['line', { x1: 6, x2: 6.01, y1: 6, y2: 6 }],
        ['line', { x1: 6, x2: 6.01, y1: 18, y2: 18 }],
    ],
    // Cog
    worker: [
        ['path', { d: 'M11 10.27 7 3.34' }],
        ['path', { d: 'm11 13.73-4 6.93' }],
        ['path', { d: 'M12 22v-2' }],
        ['path', { d: 'M12 2v2' }],
        ['path', { d: 'M14 12h8' }],
        ['path', { d: 'm17 20.66-1-1.73' }],
        ['path', { d: 'm17 3.34-1 1.73' }],
        ['path', { d: 'M2 12h2' }],
        ['path', { d: 'm20.66 17-1.73-1' }],
        ['path', { d: 'm20.66 7-1.73 1' }],
        ['path', { d: 'm3.34 17 1.73-1' }],
        ['path', { d: 'm3.34 7 1.73 1' }],
        ['circle', { cx: 12, cy: 12, r: 2 }],
        ['circle', { cx: 12, cy: 12, r: 8 }],
    ],
    // SquareFunction
    function: [
        ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
        ['path', { d: 'M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3' }],
        ['path', { d: 'M9 11.2h5.7' }],
    ],
    // Database
    database: [
        ['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }],
        ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
        ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
    ],
    // Zap
    cache: [['path', { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' }]],
    // Layers
    queue: [
        ['path', { d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' }],
        ['path', { d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' }],
        ['path', { d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' }],
    ],
    // Waves
    stream: [
        ['path', { d: 'M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
        ['path', { d: 'M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
        ['path', { d: 'M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
    ],
    // HardDrive
    storage: [
        ['line', { x1: 22, x2: 2, y1: 12, y2: 12 }],
        ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
        ['line', { x1: 6, x2: 6.01, y1: 16, y2: 16 }],
        ['line', { x1: 10, x2: 10.01, y1: 16, y2: 16 }],
    ],
    // Search
    search: [
        ['path', { d: 'm21 21-4.34-4.34' }],
        ['circle', { cx: 11, cy: 11, r: 8 }],
    ],
    // Globe
    cdn: [
        ['circle', { cx: 12, cy: 12, r: 10 }],
        ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
        ['path', { d: 'M2 12h20' }],
    ],
    // Signpost
    dns: [
        ['path', { d: 'M12 13v8' }],
        ['path', { d: 'M12 3v3' }],
        ['path', { d: 'M18 6a2 2 0 0 1 1.387.56l2.307 2.22a1 1 0 0 1 0 1.44l-2.307 2.22A2 2 0 0 1 18 13H6a2 2 0 0 1-1.387-.56l-2.306-2.22a1 1 0 0 1 0-1.44l2.306-2.22A2 2 0 0 1 6 6z' }],
    ],
    // Network
    gateway: [
        ['rect', { x: 16, y: 16, width: 6, height: 6, rx: 1 }],
        ['rect', { x: 2, y: 16, width: 6, height: 6, rx: 1 }],
        ['rect', { x: 9, y: 2, width: 6, height: 6, rx: 1 }],
        ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }],
        ['path', { d: 'M12 12V8' }],
    ],
    // Split
    lb: [
        ['path', { d: 'M16 3h5v5' }],
        ['path', { d: 'M8 3H3v5' }],
        ['path', { d: 'M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3' }],
        ['path', { d: 'm15 9 6-6' }],
    ],
    // ShieldCheck
    auth: [
        ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
        ['path', { d: 'm9 12 2 2 4-4' }],
    ],
    // Cloud
    external: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
    // Gauge
    monitor: [
        ['path', { d: 'm12 14 4-4' }],
        ['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }],
    ],
    // Clock
    scheduler: [
        ['path', { d: 'M12 6v6l4 2' }],
        ['circle', { cx: 12, cy: 12, r: 10 }],
    ],
    // Bell
    notify: [
        ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }],
        ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }],
    ],
    // BrainCircuit
    model: [
        ['path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }],
        ['path', { d: 'M9 13a4.5 4.5 0 0 0 3-4' }],
        ['path', { d: 'M6.003 5.125A3 3 0 0 0 6.401 6.5' }],
        ['path', { d: 'M3.477 10.896a4 4 0 0 1 .585-.396' }],
        ['path', { d: 'M6 18a4 4 0 0 1-1.967-.516' }],
        ['path', { d: 'M12 13h4' }],
        ['path', { d: 'M12 18h6a2 2 0 0 1 2 2v1' }],
        ['path', { d: 'M12 8h8' }],
        ['path', { d: 'M16 8V5a2 2 0 0 1 2-2' }],
        ['circle', { cx: 16, cy: 13, r: 0.5 }],
        ['circle', { cx: 18, cy: 3, r: 0.5 }],
        ['circle', { cx: 20, cy: 21, r: 0.5 }],
        ['circle', { cx: 20, cy: 8, r: 0.5 }],
    ],
};

/** An icon as SVG elements, `size` px square with its top-left at (x, y), in `color`. */
export function iconSvg(kind: CanvasKind, x: number, y: number, size: number, color: string): string {
    const parts = KIND_ICON_PARTS[kind].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`);
    const scale = size / 24;
    return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</g>`;
}

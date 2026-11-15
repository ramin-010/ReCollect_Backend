// SVG → PNG with resvg (@resvg/resvg-js 2.6.2, MPL-2.0: a Rust renderer, no browser), for the
// agent's preview and "Save as PNG". Text uses the system's fonts: Segoe UI on Windows, else Arial.
// NOTE: a Linux server has neither; it will need a font bundled with the app (and passed in
// `font.fontFiles`) so previews keep their text.
import type { ResvgRenderOptions } from '@resvg/resvg-js';

/** The longest side a PNG may have (a 300-box board at 2× would otherwise be enormous). */
export const PNG_MAX_SIDE = 8000;

let resvg: typeof import('@resvg/resvg-js') | null = null;

/** The native renderer, loaded on first use. */
function renderer(): typeof import('@resvg/resvg-js') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    resvg ??= require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
    return resvg;
}

export interface Png {
    png: Buffer;
    width: number;
    height: number;
}

/**
 * An SVG `width`×`height` px as a PNG at `scale` (2 by default: sharp on a retina screen), never
 * longer than `maxSide` px on a side. `fontFiles`: fonts the SVG brings (then no system fonts).
 */
export function svgToPng(svg: string, width: number, height: number, scale = 2, maxSide = PNG_MAX_SIDE, fontFiles?: string[]): Png {
    const zoom = Math.max(0.1, Math.min(scale, maxSide / Math.max(width, height, 1)));
    const options: ResvgRenderOptions = {
        fitTo: { mode: 'zoom', value: zoom },
        // `fontFiles`: the picture brings its own (the wallpaper's Inter); otherwise the system's.
        font: fontFiles?.length
            ? { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter', sansSerifFamily: 'Inter' }
            : { loadSystemFonts: true, defaultFontFamily: 'Segoe UI', sansSerifFamily: 'Arial' },
    };
    const image = new (renderer().Resvg)(svg, options).render();
    return { png: image.asPng(), width: image.width, height: image.height };
}

// Stage 11 (ECOSYSTEM_V2_PLAN, his item 10a): where a wallpaper's words may go on regular Android phones, and the phones
// they are checked on. tests/unit/utils/wallpaperSafeZones.test.ts holds every word of every style to these zones on
// every size; scripts/wallpaper-matrix-sheet.ts draws the contact sheet with them dashed in.
import type { WallpaperScreen } from './ambient.service';

/** The phones of the matrix (portrait pixels): 16:9 to 21:9. Tablets and foldables are out of scope (his word). */
export const SIZE_MATRIX: ReadonlyArray<readonly [number, number]> = [
    [720, 1600],
    [1080, 1920],
    [1080, 2340],
    [1080, 2400],
    [1080, 2520],
    [1440, 3200],
];

/**
 * Where words may go, as fractions of the screen (x from the left, y from the top). The lock screen: below the maker's
 * clock and date (the top 26 %), above the in-display fingerprint and the corner shortcuts (from 84 %). The home screen:
 * below the status bar (4 %), above the dock and the navigation (from 86 %). Both: 5 % from each side.
 */
export const SAFE_ZONES: Record<WallpaperScreen, { left: number; right: number; top: number; bottom: number }> = {
    lock: { left: 0.05, right: 0.95, top: 0.26, bottom: 0.84 },
    home: { left: 0.05, right: 0.95, top: 0.04, bottom: 0.86 },
};

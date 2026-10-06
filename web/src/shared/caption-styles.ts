// GENERATED — do not edit. Source: shared/src/caption-styles.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { DEFAULT_CAPTION_STYLE_ID } from "./enums";

/**
 * Burned-in caption looks (docs/SCHEMA.md: presets live in code; brand kits come later).
 * Sizes are shares of the output height so one preset works for 9:16, 1:1 and 16:9.
 * Colours are ASS `&HAABBGGRR` (alpha 00 = opaque).
 *
 * The font must be in worker/assets/fonts (ffmpeg's `fontsdir`) and cover BOTH Bengali and
 * Latin: Bangla transcripts keep acronyms and brand names in Latin script (D42).
 */
export type CaptionStyle = {
  id: string;
  label: string;
  fontFamily: string;
  bold: boolean;
  /** Font size ÷ output height. */
  size: number;
  primaryColour: string;
  outlineColour: string;
  backColour: string;
  /** 1 = outline + shadow, 3 = opaque box behind the text. */
  borderStyle: 1 | 3;
  /** Outline (or box padding) ÷ output height. */
  outline: number;
  shadow: number;
  /** Distance of the text's bottom from the frame's bottom ÷ output height — above the app buttons of Reels/Shorts/TikTok. */
  marginV: number;
  /** Most characters (graphemes) on screen at once; longer phrases are split. */
  maxChars: number;
  maxWords: number;
  /** A short grow-in when each phrase appears. */
  pop: boolean;
};

export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  "preset:bold": {
    id: "preset:bold",
    label: "Bold",
    fontFamily: "Hind Siliguri",
    bold: true,
    size: 0.05,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    backColour: "&H99000000",
    borderStyle: 1,
    outline: 0.004,
    shadow: 0.0015,
    marginV: 0.16,
    maxChars: 18,
    maxWords: 4,
    pop: true,
  },
  "preset:clean": {
    id: "preset:clean",
    label: "Clean",
    fontFamily: "Hind Siliguri",
    bold: true,
    size: 0.032,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H99000000",
    backColour: "&H99000000",
    borderStyle: 3,
    outline: 0.006,
    shadow: 0,
    marginV: 0.2,
    maxChars: 30,
    maxWords: 6,
    pop: false,
  },
};

/** The style for an id; unknown ids (e.g. a deleted brand kit) fall back to the default. */
export function captionStyle(id: string | null | undefined): CaptionStyle {
  return CAPTION_STYLES[id ?? ""] ?? CAPTION_STYLES[DEFAULT_CAPTION_STYLE_ID]!;
}

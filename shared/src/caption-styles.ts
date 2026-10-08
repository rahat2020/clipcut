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
  /** Key words (clip.copy.emphasis, else numbers) in this colour; null = no emphasis. */
  highlightColour: string | null;
  /** The first ~2 s of the clip (the hook) in bigger letters with a bounce. */
  hook: boolean;
};

/**
 * Hook and emphasis rules (render@3). Phrase-level only: Bangla word times are estimates (D42) —
 * measured 2026-10-07, the right word would be lit only ~36 % of the time with word-by-word
 * highlighting, so colour marks key words for the whole phrase instead.
 */
export const CAPTION_LOOK = {
  /** Phrases that start before this are the hook. */
  hookMs: 2_000,
  hookMaxPhrases: 2,
  hookScale: 1.3,
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
    highlightColour: "&H0000D4FF",
    hook: true,
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
    highlightColour: "&H0000D4FF",
    hook: false,
  },
  "preset:pop": {
    id: "preset:pop",
    label: "Pop",
    fontFamily: "Hind Siliguri",
    bold: true,
    size: 0.058,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    backColour: "&H99000000",
    borderStyle: 1,
    outline: 0.006,
    shadow: 0.002,
    marginV: 0.2,
    maxChars: 14,
    maxWords: 3,
    pop: true,
    highlightColour: "&H0012FFA3",
    hook: true,
  },
  "preset:fire": {
    id: "preset:fire",
    label: "Fire",
    fontFamily: "Hind Siliguri",
    bold: true,
    size: 0.052,
    primaryColour: "&H004DE1FF",
    outlineColour: "&H00000000",
    backColour: "&H99000000",
    borderStyle: 1,
    outline: 0.005,
    shadow: 0.0015,
    marginV: 0.17,
    maxChars: 16,
    maxWords: 4,
    pop: true,
    highlightColour: "&H002E4DFF",
    hook: true,
  },
  "preset:minimal": {
    id: "preset:minimal",
    label: "Minimal",
    fontFamily: "Hind Siliguri",
    bold: true,
    size: 0.034,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H66000000",
    backColour: "&H80000000",
    borderStyle: 1,
    outline: 0.002,
    shadow: 0.002,
    marginV: 0.14,
    maxChars: 28,
    maxWords: 6,
    pop: false,
    highlightColour: null,
    hook: false,
  },
};

/** The style for an id; unknown ids (e.g. a deleted brand kit) fall back to the default. */
export function captionStyle(id: string | null | undefined): CaptionStyle {
  return CAPTION_STYLES[id ?? ""] ?? CAPTION_STYLES[DEFAULT_CAPTION_STYLE_ID]!;
}

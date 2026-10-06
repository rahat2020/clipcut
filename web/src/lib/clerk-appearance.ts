/**
 * Clerk's sign-in / sign-up / user menu in the Cutroom theme.
 * Clerk derives hover and shade colors from these, so they must be real colors, not
 * CSS variables — keep them in sync with the tokens in src/app/globals.css.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: "#c8f169",
    colorPrimaryForeground: "#12110f",
    colorBackground: "#161513",
    colorForeground: "#f2efea",
    colorMuted: "#1d1b19",
    colorMutedForeground: "#a9a39a",
    colorInput: "#121110",
    colorInputForeground: "#f2efea",
    colorBorder: "#2b2926",
    colorNeutral: "#f2efea",
    colorDanger: "#ff8a65",
    colorRing: "#c8f169",
    colorShadow: "#000000",
    fontFamily: "var(--font-geist), var(--font-hind), system-ui, sans-serif",
    borderRadius: "0.625rem",
  },
} as const;

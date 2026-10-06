/**
 * Per-browser UI preferences kept in cookies (not the database): read by server layouts so
 * the first paint already matches, written by the client when the user changes them.
 */

/** "collapsed" | "expanded" — the app sidebar (desktop). */
export const SIDEBAR_COOKIE = "cc_sidebar";

// The bundled web fonts (#48): Vite copies the woff2 files into the build, so
// nothing is fetched from a font CDN at runtime. Latin only, and only the
// weights the tokens use (FONT_WEIGHT in ./tokens.ts).

import "@fontsource/limelight/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/courier-prime/latin-400.css";
import "@fontsource/courier-prime/latin-700.css";
import { FONT_STACK } from "./tokens.ts";

/** `FontFaceSet.load` queries for the faces the map draws with (PixiJS can't wait for a font itself). */
export const MAP_FONT_QUERIES: readonly string[] = [`12px '${FONT_STACK.ui[0]}'`];

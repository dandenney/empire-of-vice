// Renders its children once the given web fonts have loaded (or failed to).
// The PixiJS map draws its labels into a canvas once per snapshot, so it must
// not draw before its font is ready, or it would keep the fallback face.

import { useEffect, useState, type ReactNode } from "react";
import { MAP_FONT_QUERIES } from "./fonts.ts";

export function FontsReady({ children, queries = MAP_FONT_QUERIES }: { readonly children: ReactNode; readonly queries?: readonly string[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const done = () => {
      if (live) setReady(true);
    };
    Promise.all(queries.map((q) => document.fonts.load(q))).then(done, done);
    return () => {
      live = false;
    };
  }, [queries]);
  return ready ? children : null;
}

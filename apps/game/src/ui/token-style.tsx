// Mounts the design tokens (./tokens.ts) as CSS custom properties on :root.

import { tokenCss } from "./tokens.ts";

const CSS = tokenCss();

export function TokenStyle() {
  return <style data-tokens="">{CSS}</style>;
}

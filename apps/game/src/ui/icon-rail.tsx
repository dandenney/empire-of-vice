// The vertical icon rail (#48): one button per panel, named for the panel
// (its title is the accessible name and the hover/focus tooltip). Tab reaches
// each button; Up/Down (and Home/End) move between them, Enter or Space opens.

import type { KeyboardEvent } from "react";
import { PANEL_ICONS, PanelIcon } from "./icons.tsx";

export interface RailItem {
  readonly id: string;
  readonly title: string;
}

const MOVES: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

export function IconRail({ items, openId, onOpen, label }: { readonly items: readonly RailItem[]; readonly openId: string; readonly onOpen: (id: string) => void; readonly label: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const move = MOVES[e.key];
    if (!move) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-rail-item]")];
    const index = buttons.findIndex((b) => b === document.activeElement);
    if (index < 0) return;
    e.preventDefault();
    buttons[move(index, buttons.length)]?.focus();
  };

  return (
    <nav className="rail" aria-label={label} onKeyDown={onKeyDown}>
      <ul className="rail-list">
        {items.map((item) => {
          const Glyph = PANEL_ICONS[item.id] ?? PanelIcon;
          return (
            <li key={item.id}>
              <button
                type="button"
                className="rail-button"
                data-rail-item
                data-testid={`open-${item.id}`}
                aria-label={item.title}
                aria-pressed={item.id === openId}
                data-tooltip={item.title}
                onClick={() => onOpen(item.id)}
              >
                <Glyph />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

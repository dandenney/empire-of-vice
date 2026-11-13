// O1b (#197, ADR 0022 decision 7): the balance sheet shows the conversion cost
// prepaid for running batches as its own asset line, between goods in transit and
// receivables, and it counts toward total assets.

import { formatMoney, type GameSnapshot } from "@eov/contracts";
import { midGameSnapshot, startOfGameSnapshot } from "@eov/contracts/fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASSET_COPY } from "../../../src/panels/finance/copy.ts";
import { FinancePanel } from "../../../src/panels/finance/finance-panel.tsx";

const render = (snapshot: GameSnapshot) => renderToStaticMarkup(<FinancePanel snapshot={snapshot} />);
/** The text of an asset line's figure cell, tags stripped. */
const line = (html: string, key: string) => new RegExp(`data-testid="finance-asset-${key}"[^>]*>(.*?)</td>`).exec(html)?.[1]?.replace(/<[^>]*>/g, "");

describe("finance balance sheet: production in progress", () => {
  it("shows the prepaid conversion cost of running batches", () => {
    const html = render(midGameSnapshot);
    const amount = midGameSnapshot.finance.balanceSheet.assets.productionInProgress;
    expect(amount).toBeGreaterThan(0);
    expect(html).toContain(ASSET_COPY.productionInProgress);
    expect(line(html, "productionInProgress")).toBe(formatMoney(amount));
  });

  it("shows $0.00 when nothing is running", () => {
    expect(line(render(startOfGameSnapshot), "productionInProgress")).toBe(formatMoney(startOfGameSnapshot.finance.balanceSheet.assets.productionInProgress));
  });

  it("sits after goods in transit and before receivables", () => {
    const keys = Object.keys(ASSET_COPY);
    expect(keys.indexOf("productionInProgress")).toBe(keys.indexOf("goodsInTransit") + 1);
    expect(keys.indexOf("receivables")).toBe(keys.indexOf("productionInProgress") + 1);
  });
});

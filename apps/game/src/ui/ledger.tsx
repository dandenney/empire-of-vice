// Ledger-style money (#48): typewriter figures with tabular widths, losses in
// the loss colour and always with a minus sign (formatMoney's), so colour is
// never the only signal. Totals get a rule above and a double rule below.

import { formatMoney, type Money } from "@eov/contracts";
import type { ReactNode } from "react";

export type MoneySign = "loss" | "zero" | "gain";

export function moneySign(amount: Money): MoneySign {
  return amount < 0 ? "loss" : amount > 0 ? "gain" : "zero";
}

/** A money figure. Its text is exactly `formatMoney(amount)`. */
export function MoneyFigure({ amount }: { readonly amount: Money }) {
  return (
    <span className="money" data-sign={moneySign(amount)}>
      {formatMoney(amount)}
    </span>
  );
}

/** A ruled ledger table: caption, optional column heads, and rows. */
export function LedgerTable({ caption, children, testId, className }: { readonly caption?: ReactNode; readonly children: ReactNode; readonly testId?: string; readonly className?: string }) {
  return (
    <table className={className ? `ledger ${className}` : "ledger"} data-testid={testId}>
      {caption !== undefined && <caption>{caption}</caption>}
      {children}
    </table>
  );
}

/** One ledger line: a label and a money figure. `total` rules it off. */
export function LedgerLine({ label, amount, testId, total }: { readonly label: ReactNode; readonly amount: Money; readonly testId: string; readonly total?: boolean }) {
  return (
    <tr className={total ? "ledger-total" : undefined}>
      <th scope="row">{label}</th>
      <td className="figure" data-testid={testId}>
        <MoneyFigure amount={amount} />
      </td>
    </tr>
  );
}

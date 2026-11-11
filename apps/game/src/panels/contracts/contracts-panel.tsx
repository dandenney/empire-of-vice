// Contracts (GDD §4 action 7, GDD §7, ADR 0018): offers with their terms and
// ACCEPT_CONTRACT; active contracts with each installment's deadline,
// required, delivered, outcome and penalty; what each contract holds, with
// RELEASE_RESERVATION; a delivery (DISPATCH_DELIVERY, purpose
// CONTRACT_INSTALLMENT) through the shared route picker; and every reserved
// quantity, including materials held by running production, which the player
// can't release (ADR 0013 decision 2).
//
// Every figure and enabled state comes from the snapshot (ADR 0007). Durations
// are the snapshot's (`intervalTicks`, the routes' `durationTicks`), never the
// fixtures'. Quantities aren't clamped: a request the simulation rejects shows
// its typed reason.

import type { ContractOfferSnapshot, ContractSnapshot, GameSnapshot, ReservationId } from "@eov/contracts";
import { COMMON_COPY } from "../../components/copy.ts";
import { describeReason, formatQuality } from "../../components/format.ts";
import { useCommand } from "../../components/use-command.ts";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import type { PanelProps } from "../registry.ts";
import { CommandResult } from "./command-result.tsx";
import { CONTRACTS_COPY as C } from "./copy.ts";
import { formatDayTime, formatSpan } from "../../ui/format/time-format.ts";
import { formatPpmPercent, reservedLines } from "./contracts-view.ts";
import { DeliveryForm } from "./delivery-form.tsx";
import "./contracts.css";

const installmentKey = (testId: string, index: number) => `${testId}-installment-${index}`;

type Terms =Pick<ContractOfferSnapshot, "quantityPerInstallment" | "installmentCount" | "intervalTicks" | "unitPrice" | "penaltyRatePpm">;

function TermsFacts({ terms, testId }: { readonly terms: Terms; readonly testId: string }) {
  return (
    <dl className="contract-facts">
      <div>
        <dt>{C.perInstallment}</dt>
        <dd data-testid={`${testId}-quantity`}>{terms.quantityPerInstallment}</dd>
      </div>
      <div>
        <dt>{C.installments}</dt>
        <dd data-testid={`${testId}-count`}>{terms.installmentCount}</dd>
      </div>
      <div>
        <dt>{C.every}</dt>
        <dd data-testid={`${testId}-interval`}>{formatSpan(terms.intervalTicks)}</dd>
      </div>
      <div>
        <dt>{C.unitPrice}</dt>
        <dd data-testid={`${testId}-price`}>
          <MoneyFigure amount={terms.unitPrice} />
        </dd>
      </div>
      <div>
        <dt>{C.penalty}</dt>
        <dd className="contract-fact-text" data-testid={`${testId}-penalty`}>
          {C.penaltyLine(formatPpmPercent(terms.penaltyRatePpm))}
        </dd>
      </div>
    </dl>
  );
}

function OfferCard({ offer }: { readonly offer: ContractOfferSnapshot }) {
  const command = useCommand(`accept-contract:${offer.id}`);
  const testId = `offer-${offer.id}`;
  const accept = () => command.send({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } });
  return (
    <article className="contract-card" data-testid={testId} aria-labelledby={`${testId}-name`}>
      <h4 className="contract-card-name" id={`${testId}-name`}>
        {C.offerName(offer.buyerName)}
      </h4>
      <p className="contract-wants" data-testid={`${testId}-wants`}>
        {C.wants(offer.productName, formatQuality(offer.minimumQuality))}
      </p>
      <TermsFacts terms={offer} testId={testId} />
      <dl className="contract-facts">
        <div>
          <dt>{C.firstDeadline}</dt>
          <dd data-testid={`${testId}-first-deadline`}>{formatDayTime(offer.firstDeadline)}</dd>
        </div>
        <div>
          <dt>{C.expires}</dt>
          <dd data-testid={`${testId}-expires`}>{formatDayTime(offer.expiresAt)}</dd>
        </div>
      </dl>
      {offer.blockedBy !== null && (
        <p className="contract-blocked" data-testid={`${testId}-blocked`}>
          <span className="field-label">{C.blockedBy}</span> {describeReason(offer.blockedBy)}
        </p>
      )}
      <div className="contract-action">
        <button type="button" className="button button-primary" onClick={accept} disabled={command.pending || offer.blockedBy !== null} aria-label={C.acceptLabel(offer.buyerName)} data-testid={`${testId}-accept`}>
          {C.accept}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </div>
    </article>
  );
}

function InstallmentsTable({ contract, testId }: { readonly contract: ContractSnapshot; readonly testId: string }) {
  return (
    <LedgerTable caption={C.installmentsCaption} className="ledger-columns contract-installments" testId={`${testId}-installments`}>
      <thead>
        <tr>
          <th scope="col">{C.installment}</th>
          <th scope="col">{C.deadline}</th>
          <th scope="col" className="figure">
            {C.required}
          </th>
          <th scope="col" className="figure">
            {C.delivered}
          </th>
          <th scope="col" className="figure">
            {C.inTransit}
          </th>
          <th scope="col">{C.outcome}</th>
          <th scope="col" className="figure">
            {C.penaltyCharged}
          </th>
        </tr>
      </thead>
      <tbody>
        {contract.installments.map((i) => {
          const key = installmentKey(testId, i.index);
          return (
            <tr key={i.index} data-testid={key} data-outcome={i.outcome ?? "OPEN"}>
              <th scope="row">{C.installmentNumber(i.index)}</th>
              <td className="contract-deadline" data-testid={`${key}-deadline`}>
                {formatDayTime(i.deadline)}
              </td>
              <td className="figure" data-testid={`${key}-required`}>
                {i.required}
              </td>
              <td className="figure" data-testid={`${key}-delivered`}>
                {i.delivered}
              </td>
              <td className="figure" data-testid={`${key}-in-transit`}>
                {i.inTransit}
              </td>
              <td className="contract-outcome" data-testid={`${key}-outcome`}>
                {i.outcome === null ? C.pending : C.outcomes[i.outcome]}
              </td>
              <td className="figure" data-testid={`${key}-penalty`}>
                {i.penalty === null ? <span className="money-none">{COMMON_COPY.none}</span> : <MoneyFigure amount={i.penalty} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </LedgerTable>
  );
}

function ReleaseButton({ contract, reservationId, n, count }: { readonly contract: ContractSnapshot; readonly reservationId: ReservationId; readonly n: number; readonly count: number }) {
  const command = useCommand(`release-reservation:${reservationId}`);
  const testId = `release-${reservationId}`;
  const release = () => command.send({ command: { type: "RELEASE_RESERVATION", reservationId } });
  return (
    <div className="contract-action">
      <button type="button" className="button" onClick={release} disabled={command.pending} aria-label={C.releaseLabel(contract.buyerName, n)} data-testid={testId}>
        {count === 1 ? C.release : C.releaseNumbered(n)}
      </button>
      <CommandResult command={command} testId={`${testId}-result`} />
    </div>
  );
}

function ContractCard({ contract, snapshot }: { readonly contract: ContractSnapshot; readonly snapshot: GameSnapshot }) {
  const testId = `contract-${contract.id}`;
  return (
    <article className="contract-card" data-testid={testId} aria-labelledby={`${testId}-name`}>
      <h4 className="contract-card-name" id={`${testId}-name`}>
        {contract.buyerName}
      </h4>
      <p className="contract-wants" data-testid={`${testId}-wants`}>
        {C.wants(contract.productName, formatQuality(contract.minimumQuality))}
      </p>
      <TermsFacts terms={contract} testId={testId} />
      <InstallmentsTable contract={contract} testId={testId} />
      <section className="contract-held" aria-labelledby={`${testId}-held-title`} data-testid={`${testId}-held`}>
        <h5 className="field-label contract-held-title" id={`${testId}-held-title`}>
          {C.held}
        </h5>
        <p className="contract-held-figure" data-testid={`${testId}-reserved`}>
          {C.heldCases(contract.reservedQuantity)}
        </p>
        {contract.reservationIds.length === 0 ? (
          <p className="contract-note">{C.nothingHeld}</p>
        ) : (
          <>
            <p className="contract-note">{C.releaseNote}</p>
            {contract.reservationIds.map((id, i) => (
              <ReleaseButton key={id} contract={contract} reservationId={id} n={i + 1} count={contract.reservationIds.length} />
            ))}
          </>
        )}
      </section>
      <DeliveryForm contract={contract} snapshot={snapshot} />
    </article>
  );
}

function ReservedSection({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const lines = reservedLines(snapshot, formatQuality);
  return (
    <section aria-labelledby="contracts-reserved-title">
      <h3 className="section-title" id="contracts-reserved-title">
        {C.reservedTitle}
      </h3>
      <p className="contracts-intro">{C.reservedIntro}</p>
      {lines.length === 0 ? (
        <p className="panel-empty" data-testid="reserved-none">
          {C.noReserved}
        </p>
      ) : (
        <ul className="contract-reserved" data-testid="reserved-lines">
          {lines.map((l) => (
            <li key={l.key} data-holder={l.holder} data-testid={`reserved-${l.key}`}>
              <span className="field-label">{l.facilityName}</span> {l.line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ContractsPanel({ snapshot }: PanelProps) {
  const { offers, active, closed } = snapshot.contracts;
  return (
    <section className="panel" data-testid="panel-contracts" aria-labelledby="contracts-title">
      <h2 className="panel-title" id="contracts-title">
        {C.title}
      </h2>
      <p className="contracts-intro">{C.intro}</p>
      <section aria-labelledby="contracts-active-title">
        <h3 className="section-title" id="contracts-active-title">
          {C.activeTitle}
        </h3>
        {active.length === 0 ? (
          <p className="panel-empty" data-testid="contracts-no-active">
            {C.noActive}
          </p>
        ) : (
          active.map((c) => <ContractCard key={c.id} contract={c} snapshot={snapshot} />)
        )}
      </section>
      <section aria-labelledby="contracts-offers-title">
        <h3 className="section-title" id="contracts-offers-title">
          {C.offersTitle}
        </h3>
        {offers.length === 0 ? (
          <p className="panel-empty" data-testid="contracts-no-offers">
            {C.noOffers}
          </p>
        ) : (
          offers.map((o) => <OfferCard key={o.id} offer={o} />)
        )}
      </section>
      <ReservedSection snapshot={snapshot} />
      {closed.length > 0 && (
        <section aria-labelledby="contracts-closed-title">
          <h3 className="section-title" id="contracts-closed-title">
            {C.closedTitle}
          </h3>
          <ul className="contract-reserved" data-testid="contracts-closed">
            {closed.map((c) => (
              <li key={c.id} data-testid={`closed-${c.id}`}>
                {C.closedLine(c.buyerName, C.outcomeList(c.installments.map((i) => (i.outcome === null ? C.pending : C.outcomes[i.outcome]))))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

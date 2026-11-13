// A spot sale from the sale form (ADR 0022 decision 6): AGREE_DEAL at the price
// the panel shows, then DISPATCH_DELIVERY against that deal, as one click. With
// founder rules off that's M001's sale: the buyer's checks (QUOTE_CHANGED,
// BUYER_WILL_TAKE_LESS) come back from the agreement, the truck's and the
// stock's from the dispatch.
//
// The new deal's ID comes from the agreement's DEAL_AGREED event in the snapshot
// the worker posts before the result. If the dispatch is rejected, the buyer keeps
// holding the deal (it expires on its own), so the form remembers the handle and
// a retry with the same terms dispatches against it rather than agreeing again.
// The handle is a request's bookkeeping, like the outcome: not game state.

import type { BuyerId, CommandRequest, DealId, Money, ProductId, QualityTier, RouteId, VehicleId } from "@eov/contracts";
import { useCallback, useRef, useState } from "react";
import { useGateway, useUi } from "../../state/app-context.tsx";
import type { DispatchOutcome, GatewayClient } from "../../state/gateway-client.ts";

export interface SaleTerms {
  readonly vehicleId: VehicleId;
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly agreedUnitPrice: Money;
  readonly routeId: RouteId | null;
}

export interface SaleHandle {
  readonly pending: boolean;
  readonly outcome: DispatchOutcome | null;
  readonly error: string | null;
  sell(terms: SaleTerms): Promise<void>;
}

const sameDeal = (a: SaleTerms, b: SaleTerms) =>
  a.buyerId === b.buyerId && a.productId === b.productId && a.quality === b.quality && a.quantity === b.quantity && a.agreedUnitPrice === b.agreedUnitPrice;

/** The deal an applied AGREE_DEAL minted: its DEAL_AGREED event, in the snapshot posted with the result. */
function agreedDeal(gateway: GatewayClient, outcome: DispatchOutcome): DealId | null {
  if (outcome.kind !== "result" || outcome.result.status !== "applied") return null;
  const ids = new Set(outcome.result.eventIds);
  const event = gateway.view.snapshot?.recentEvents.find((e) => ids.has(e.id) && e.type === "DEAL_AGREED");
  return event?.type === "DEAL_AGREED" ? event.dealId : null;
}

export function useSale(key: string): SaleHandle {
  const gateway = useGateway();
  const pending = useUi((s) => key in s.pending);
  const setPending = useUi((s) => s.setPending);
  const [outcome, setOutcome] = useState<DispatchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A deal this form agreed whose dispatch was rejected, kept for a retry on the same terms. */
  const held = useRef<{ readonly terms: SaleTerms; readonly dealId: DealId; readonly game: number } | null>(null);

  const sell = useCallback(
    async (terms: SaleTerms) => {
      setPending(key, true);
      setError(null);
      try {
        const game = gateway.view.game;
        let dealId = held.current && held.current.game === game && sameDeal(held.current.terms, terms) ? held.current.dealId : null;
        held.current = null;
        if (dealId === null) {
          const agreement: CommandRequest = {
            command: {
              type: "AGREE_DEAL",
              buyerId: terms.buyerId,
              productId: terms.productId,
              quality: terms.quality,
              quantity: terms.quantity,
              agreedUnitPrice: terms.agreedUnitPrice,
            },
          };
          const agreed = await gateway.dispatch(agreement);
          dealId = agreedDeal(gateway, agreed);
          if (dealId === null) {
            setOutcome(agreed);
            return;
          }
        }
        const dispatched = await gateway.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: terms.vehicleId,
            cargo: [{ productId: terms.productId, quality: terms.quality, quantity: terms.quantity }],
            purpose: { kind: "SALE", buyerId: terms.buyerId, dealId },
            routeId: terms.routeId,
            driver: { kind: "FOUNDER" },
          },
        });
        const rejected = dispatched.kind === "result" && dispatched.result.status === "rejected";
        if (rejected && dispatched.result.reason.code !== "DEAL_UNAVAILABLE") held.current = { terms, dealId, game };
        setOutcome(dispatched);
      } catch (e) {
        setOutcome(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(key, false);
      }
    },
    [gateway, key, setPending],
  );

  return { pending, outcome, error, sell };
}

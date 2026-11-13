// A place scene (SK2b, #234; GDD §18): arriving opens it, leaving returns to
// the map. A PLACEHOLDER illustration (marked on screen) whose blocks are the
// state layers, then the actions that can be taken here. Every action goes
// through the gateway (useCommand) and the scene reports the result.
// Everything shown comes from the player snapshot (CLAUDE.md rule 7); form
// values are UI-only state.

import type { FacilityId, LocationId, PlayerSnapshot, QualityTier, Tick } from "@eov/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { describeOutcome, describeReason, formatQuality } from "../components/format.ts";
import { useCommand } from "../components/use-command.ts";
import { formatAge } from "../ledger/ledger-view.ts";
import { formatDayTime, formatSpan } from "../ui/format/time-format.ts";
import { SCENES_COPY as C } from "./copy.ts";
import { clockTime, type HoursView } from "./hours.ts";
import {
  sceneView,
  type ActionBlock,
  type AgreeDealAction,
  type BuyAction,
  type DispatchAction,
  type RestAction,
  type SceneAction,
  type SceneLayer,
  type Seen,
  type StartBatchAction,
} from "./scene-view.ts";
import "./scenes.css";

function hoursText(hours: HoursView): string {
  if (hours.kind === "ALWAYS") return C.hours.always;
  const text = hours.intervals.map((i) => C.hours.interval(clockTime(i.opensAtMinute), clockTime(i.closesAtMinute))).join(C.hours.separator);
  return hours.open ? C.hours.open(text) : C.hours.closed(text, hours.opensAt === null ? null : formatDayTime(hours.opensAt));
}

export function blockText(block: ActionBlock): string {
  switch (block.code) {
    case "BUSY":
      return C.blocked.BUSY(formatDayTime(block.until));
    case "CLOSED":
      return C.blocked.CLOSED(block.opensAt === null ? null : formatDayTime(block.opensAt));
    case "REASON":
      return describeReason(block.reason);
    default:
      return C.blocked[block.code];
  }
}

function SeenNote({ seen, now }: { readonly seen: Seen | null; readonly now: Tick }) {
  if (seen === null || seen.learnedAt >= now) return null;
  return <span className="scene-layer-seen">{C.layer.seen(formatAge(seen.learnedAt, now).age)}</span>;
}

function Layer({ layer, now }: { readonly layer: SceneLayer; readonly now: Tick }) {
  let body: ReactNode;
  let seen: Seen | null = null;
  switch (layer.kind) {
    case "CRATES":
      body = C.layer.crates(layer.cases);
      seen = layer.seen;
      break;
    case "MATERIALS":
      body = layer.lines.length === 0 ? C.layer.noMaterials : layer.lines.map((l) => C.layer.material(l.name, l.quantity)).join(C.hours.separator);
      seen = layer.seen;
      break;
    case "STILL":
      body = C.layer.still(layer.batches, layer.doneAt === null ? null : formatDayTime(layer.doneAt));
      seen = layer.seen;
      break;
    case "TRUCK":
      body = layer.here === null ? C.layer.truckUnknown : layer.here ? C.layer.truckHere : C.layer.truckGone;
      seen = layer.seen;
      break;
    case "SHELVES":
      body = layer.seen === null ? C.layer.shelvesUnknown : layer.lines.map((l) => C.layer.shelf(l.name, l.available, l.unitPrice)).join(C.hours.separator);
      seen = layer.seen;
      break;
    case "WANTS":
      body =
        layer.seen === null
          ? C.layer.wantsUnknown
          : !layer.willDeal
            ? C.layer.wontDeal
            : layer.lines.length === 0
              ? C.layer.wantsNothing
              : layer.lines.map((l) => C.layer.want(l.name, formatQuality(l.minimumQuality), l.unitPrice, l.demand)).join(C.hours.separator);
      seen = layer.seen;
      break;
    case "BUDGET":
      body = layer.amount === null ? C.layer.budgetUnknown : C.layer.budget(layer.amount);
      seen = layer.seen;
      break;
    case "EMPTY":
      body = C.layer.empty;
      break;
  }
  const state = layer.kind === "TRUCK" ? String(layer.here) : layer.kind === "CRATES" ? String(layer.cases) : layer.kind === "STILL" ? String(layer.batches) : undefined;
  return (
    <li className="scene-layer" data-testid="scene-layer" data-kind={layer.kind} data-state={state}>
      <span className="scene-layer-body">{body}</span>
      <SeenNote seen={seen} now={now} />
    </li>
  );
}

/** One action: its label, its form, why it can't be done now, and the last result. */
function ActionCard({ action, label, children, onSend }: { readonly action: SceneAction; readonly label: string; readonly children?: ReactNode; readonly onSend: () => Parameters<ReturnType<typeof useCommand>["send"]>[0] }) {
  const command = useCommand(`scene:${action.key}`);
  const disabled = action.blocked !== null || command.pending;
  return (
    <li className="scene-action" data-testid="scene-action" data-kind={action.kind} data-key={action.key} data-blocked={action.blocked?.code ?? ""}>
      <form
        className="scene-action-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void command.send(onSend());
        }}
      >
        <span className="scene-action-label">{label}</span>
        {children}
        <button type="submit" className="button button-primary" data-testid={`do-${action.key}`} disabled={disabled}>
          {submitLabel(action)}
        </button>
      </form>
      {action.blocked && <p className="scene-action-blocked">{blockText(action.blocked)}</p>}
      {(command.pending || command.outcome || command.error) && (
        <p role="status" className="scene-action-result" data-testid="scene-result" data-status={command.outcome?.kind === "invalid" ? "invalid" : (command.outcome?.result.status ?? "")}>
          {command.pending ? C.result.pending : command.error ?? (command.outcome ? describeOutcome(command.outcome) : null)}
        </p>
      )}
    </li>
  );
}

function submitLabel(action: SceneAction): string {
  switch (action.kind) {
    case "BUY":
      return C.action.buyButton;
    case "START_BATCH":
      return C.action.startButton;
    case "DISPATCH":
      return C.action.dispatchButton;
    case "AGREE_DEAL":
      return C.action.agreeButton;
    case "REST":
      return C.action.restButton;
  }
}

function QuantityField({ id, value, max, onChange }: { readonly id: string; readonly value: number; readonly max: number; readonly onChange: (n: number) => void }) {
  return (
    <label className="field">
      <span className="field-label">{C.action.quantity}</span>
      <input
        className="input scene-quantity"
        type="number"
        min={1}
        max={Math.max(1, max)}
        step={1}
        value={value}
        data-testid={id}
        onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
      />
    </label>
  );
}

function Buy({ action }: { readonly action: BuyAction }) {
  const [quantity, setQuantity] = useState(1);
  const [facilityId, setFacilityId] = useState(action.facilities[0]?.id ?? null);
  return (
    <ActionCard
      action={action}
      label={C.action.buy(action.materialName, action.unitPrice)}
      onSend={() => ({ command: { type: "PURCHASE_MATERIALS", supplierId: action.supplierId, materialId: action.materialId, quantity, facilityId: facilityId! } })}
    >
      <QuantityField id={`quantity-${action.key}`} value={quantity} max={action.available} onChange={setQuantity} />
      {action.facilities.length > 1 && (
        <label className="field">
          <span className="field-label">{C.action.deliverTo}</span>
          <select className="input" value={facilityId ?? ""} onChange={(e) => setFacilityId(e.target.value as FacilityId)}>
            {action.facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </ActionCard>
  );
}

function StartBatch({ action }: { readonly action: StartBatchAction }) {
  const [quantity, setQuantity] = useState(1);
  return (
    <ActionCard
      action={action}
      label={C.action.startBatch(action.name, action.maxQuantity)}
      onSend={() => ({ command: { type: "START_PRODUCTION", facilityId: action.facilityId, recipeId: action.recipeId, quantity } })}
    >
      <QuantityField id={`quantity-${action.key}`} value={quantity} max={action.maxQuantity} onChange={setQuantity} />
    </ActionCard>
  );
}

const SPEC = "spec";

function Dispatch({ action }: { readonly action: DispatchAction }) {
  const [purpose, setPurpose] = useState<string>(SPEC);
  const [cargoKey, setCargoKey] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [buyerId, setBuyerId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const deal = action.deals.find((d) => d.dealId === purpose) ?? null;
  const cargo = action.cargo.find((c) => c.key === cargoKey) ?? action.cargo[0] ?? null;
  const buyer = action.buyers.find((b) => b.buyerId === (deal?.buyerId ?? buyerId)) ?? (deal ? null : (action.buyers[0] ?? null));
  const route = buyer?.routes.find((r) => r.id === routeId) ?? buyer?.routes[0] ?? null;
  const ready = action.vehicleId !== null && buyer !== null && route !== null && (deal !== null || cargo !== null);
  const block = action.blocked ?? (ready ? null : ({ code: "NOT_KNOWN" } as const));
  return (
    <ActionCard
      action={{ ...action, blocked: block }}
      label={C.action.dispatch(action.vehicleName ?? "")}
      onSend={() => ({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: action.vehicleId!,
          cargo: deal ? [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }] : [{ productId: cargo!.productId, quality: cargo!.quality, quantity }],
          purpose: { kind: "SALE", buyerId: buyer!.buyerId, dealId: deal?.dealId ?? null },
          routeId: route!.id,
          driver: { kind: "FOUNDER" },
        },
      })}
    >
      <label className="field">
        <span className="field-label">{C.action.purpose}</span>
        <select className="input" data-testid="dispatch-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value={SPEC}>{C.action.onSpec}</option>
          {action.deals.map((d) => (
            <option key={d.dealId} value={d.dealId}>
              {C.action.againstDeal(C.action.deal(d.quantity, d.productName, formatQuality(d.quality), d.buyerName, d.unitPrice, formatDayTime(d.expiresAt)))}
            </option>
          ))}
        </select>
      </label>
      {deal === null && (
        <>
          <label className="field">
            <span className="field-label">{C.action.cargo}</span>
            <select className="input" data-testid="dispatch-cargo" value={cargo?.key ?? ""} onChange={(e) => setCargoKey(e.target.value)}>
              {action.cargo.map((c) => (
                <option key={c.key} value={c.key}>
                  {C.action.cargoOption(c.productName, formatQuality(c.quality), c.available)}
                </option>
              ))}
            </select>
          </label>
          <QuantityField id="dispatch-quantity" value={quantity} max={cargo?.available ?? 1} onChange={setQuantity} />
          <label className="field">
            <span className="field-label">{C.action.buyer}</span>
            <select
              className="input"
              data-testid="dispatch-buyer"
              value={buyer?.buyerId ?? ""}
              onChange={(e) => {
                setBuyerId(e.target.value);
                setRouteId(null);
              }}
            >
              {action.buyers.map((b) => (
                <option key={b.buyerId} value={b.buyerId}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="field">
        <span className="field-label">{C.action.route}</span>
        <select className="input" data-testid="dispatch-route" value={route?.id ?? ""} onChange={(e) => setRouteId(e.target.value)}>
          {(buyer?.routes ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {C.action.routeOption(r.name, formatSpan(r.durationTicks), r.riskPpm > 0, r.knownClosed)}
            </option>
          ))}
        </select>
      </label>
    </ActionCard>
  );
}

function AgreeDeal({ action }: { readonly action: AgreeDealAction }) {
  const [quality, setQuality] = useState<QualityTier>(action.minimumQuality);
  const [quantity, setQuantity] = useState(1);
  return (
    <ActionCard
      action={action}
      label={C.action.agree(action.productName, formatQuality(action.minimumQuality), action.unitPrice, action.maxQuantity)}
      onSend={() => ({ command: { type: "AGREE_DEAL", buyerId: action.buyerId, productId: action.productId, quality, quantity, agreedUnitPrice: action.unitPrice } })}
    >
      <label className="field">
        <span className="field-label">{C.action.quality}</span>
        <select className="input" value={quality} onChange={(e) => setQuality(e.target.value as QualityTier)}>
          {action.qualities.map((q) => (
            <option key={q} value={q}>
              {formatQuality(q)}
            </option>
          ))}
        </select>
      </label>
      <QuantityField id={`quantity-${action.key}`} value={quantity} max={action.maxQuantity} onChange={setQuantity} />
    </ActionCard>
  );
}

function Rest({ action }: { readonly action: RestAction }) {
  return <ActionCard action={action} label={C.action.rest(formatDayTime(action.untilTick), !action.restPlace)} onSend={() => ({ command: { type: "REST", untilTick: action.untilTick } })} />;
}

function Action({ action }: { readonly action: SceneAction }) {
  switch (action.kind) {
    case "BUY":
      return <Buy action={action} />;
    case "START_BATCH":
      return <StartBatch action={action} />;
    case "DISPATCH":
      return <Dispatch action={action} />;
    case "AGREE_DEAL":
      return <AgreeDeal action={action} />;
    case "REST":
      return <Rest action={action} />;
  }
}

/** What changed since the last visit (ADR 0021 decision 7), when this arrival's catch-up is the latest. */
function CatchUpNote({ player, locationId }: { readonly player: PlayerSnapshot; readonly locationId: LocationId }) {
  const c = player.catchUp;
  if (c === null || c.locationId !== locationId) return null;
  const changes = c.lines.length + c.news.length;
  return (
    <p className="scene-catch-up" data-testid="scene-catch-up">
      {c.sinceTick === null ? C.catchUpFirst(changes) : C.catchUp(formatDayTime(c.sinceTick), changes)}
    </p>
  );
}

export function PlaceScene({ player, locationId, onLeave }: { readonly player: PlayerSnapshot; readonly locationId: LocationId; readonly onLeave: () => void }) {
  const view = useMemo(() => sceneView(player, locationId), [player, locationId]);
  if (view === null) return null;
  const now = player.clock.tick;
  return (
    <section className="scene" data-testid="scene" data-location={view.locationId} data-kind={view.kind} aria-label={view.name}>
      <header className="scene-head">
        <div>
          <h2 className="panel-title scene-title">{view.name}</h2>
          <p className="scene-meta">
            <span className="scene-kind">{C.kind[view.kind]}</span>
            <span className="scene-hours" data-testid="scene-hours" data-open={view.hours.kind === "ALWAYS" ? "always" : String(view.hours.open)}>
              {hoursText(view.hours)}
            </span>
          </p>
        </div>
        <button type="button" className="button" data-testid="scene-leave" onClick={onLeave}>
          {C.leave}
        </button>
      </header>
      <figure className="scene-art" data-testid="scene-art">
        <figcaption className="scene-art-caption">
          <span className="placeholder-tag">{C.placeholderArt}</span>
          <span className="scene-art-note">{C.placeholderNote}</span>
        </figcaption>
        <ul className="scene-layers">
          {view.layers.map((layer, i) => (
            <Layer key={`${layer.kind}:${i}`} layer={layer} now={now} />
          ))}
        </ul>
      </figure>
      <CatchUpNote player={player} locationId={view.locationId} />
      <h3 className="group-title">{C.actionsTitle}</h3>
      <ul className="scene-actions">
        {view.actions.map((action) => (
          <Action key={action.key} action={action} />
        ))}
      </ul>
      {view.actions.length === 1 && <p className="panel-empty">{C.noActions}</p>}
    </section>
  );
}

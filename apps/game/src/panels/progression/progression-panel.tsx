// Progression (PROG-001, ADR 0020, #136): the standing the family holds, its
// reputation and net worth, what the next standing needs and unlocks, the
// victory conditions, the whole ladder, the unlocks held, and the buyers who
// want a reputation. Every figure, name, and threshold comes from
// `snapshot.progression` (with the family, finance, and buyers beside it);
// Lakeview's requirement is read, never assumed.

import { COMMON_COPY } from "../../components/copy.ts";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import type { PanelProps } from "../registry.ts";
import { PROGRESSION_COPY as C } from "./copy.ts";
import {
  currentTier,
  describeNeeds,
  nextTier,
  reputationGatedBuyers,
  requirements,
  tierStatus,
  unlockList,
  victoryConditions,
  type Requirement,
  type TierStatus,
  type VictoryCondition,
} from "./progression-view.ts";
import "./progression.css";

function Status({ met, testId }: { readonly met: boolean; readonly testId: string }) {
  return (
    <span className="progress-status" data-met={met} data-testid={testId}>
      {met ? C.met : C.notMet}
    </span>
  );
}

const REQUIREMENT_LABEL: Readonly<Record<Requirement["kind"], string>> = {
  "net-worth": C.netWorth,
  reputation: C.reputation,
};

function RequirementRow({ requirement: r }: { readonly requirement: Requirement }) {
  const testId = `progression-next-${r.kind}`;
  return (
    <tr data-testid={testId}>
      <th scope="row">{REQUIREMENT_LABEL[r.kind]}</th>
      <td className="figure" data-testid={`${testId}-required`}>
        {r.required === null ? <span className="money-none">{C.noRequirement}</span> : r.kind === "net-worth" ? <MoneyFigure amount={r.required} /> : <span className="money">{r.required}</span>}
      </td>
      <td className="figure" data-testid={`${testId}-now`}>
        {r.kind === "net-worth" ? <MoneyFigure amount={r.current} /> : <span className="money">{r.current}</span>}
      </td>
      <td className="figure">
        <Status met={r.met} testId={`${testId}-status`} />
      </td>
    </tr>
  );
}

const VICTORY_LABEL: Readonly<Record<VictoryCondition["kind"], string>> = {
  "net-worth": C.netWorth,
  reputation: C.reputation,
  "completed-contracts": C.completedContracts,
};

function VictoryRow({ condition: v }: { readonly condition: VictoryCondition }) {
  const testId = `progression-victory-${v.kind}`;
  return (
    <tr data-testid={testId}>
      <th scope="row">{VICTORY_LABEL[v.kind]}</th>
      <td className="figure" data-testid={`${testId}-target`}>
        {v.kind === "net-worth" ? <MoneyFigure amount={v.target} /> : <span className="money">{v.target}</span>}
      </td>
      <td className="figure" data-testid={`${testId}-now`}>
        {v.kind === "net-worth" ? <MoneyFigure amount={v.current} /> : <span className="money">{v.current}</span>}
      </td>
      <td className="figure">
        <Status met={v.met} testId={`${testId}-status`} />
      </td>
    </tr>
  );
}

const TIER_STATUS_LABEL: Readonly<Record<TierStatus, string>> = {
  current: C.current,
  reached: C.reached,
  "not-reached": C.notReached,
};

export function ProgressionPanel({ snapshot }: PanelProps) {
  const { progression, family, finance } = snapshot;
  const current = currentTier(snapshot);
  const next = nextTier(snapshot);
  const gated = reputationGatedBuyers(snapshot);

  return (
    <section className="panel" data-testid="panel-progression" aria-labelledby="progression-title">
      <h2 className="panel-title" id="progression-title">
        {C.title}
      </h2>

      <dl className="stats">
        <div className="stat stat-wide">
          <dt>{C.standing}</dt>
          <dd className="progress-standing" data-testid="progression-standing">
            {current?.name ?? progression.currentTierId}
          </dd>
        </div>
        <div className="stat">
          <dt>{C.reputation}</dt>
          <dd className="stat-figure" data-testid="progression-reputation">
            {family.reputation}
          </dd>
        </div>
        <div className="stat">
          <dt>{C.netWorth}</dt>
          <dd className="stat-figure" data-testid="progression-net-worth">
            <MoneyFigure amount={finance.netWorth} />
          </dd>
        </div>
      </dl>

      <section aria-labelledby="progression-next-title" data-testid="progression-next">
        <h3 className="group-title" id="progression-next-title">
          {next ? C.nextTitle(next.name) : C.nextTitleNone}
        </h3>
        {next ? (
          <>
            <LedgerTable className="ledger-columns progress-table" testId="progression-next-table">
              <thead>
                <tr>
                  <th scope="col">{C.requirement}</th>
                  <th scope="col" className="figure">
                    {C.required}
                  </th>
                  <th scope="col" className="figure">
                    {C.now}
                  </th>
                  <th scope="col" className="figure">
                    {C.status}
                  </th>
                </tr>
              </thead>
              <tbody>
                {requirements(next, snapshot).map((r) => (
                  <RequirementRow key={r.kind} requirement={r} />
                ))}
              </tbody>
            </LedgerTable>
            <p className="progress-note" data-testid="progression-next-unlocks">
              {next.unlocks.length > 0 ? C.nextUnlocks(unlockList(next.unlocks)) : C.nextUnlocksNone}
            </p>
          </>
        ) : (
          <p className="panel-empty" data-testid="progression-top-tier">
            {C.topTier}
          </p>
        )}
      </section>

      <section aria-labelledby="progression-victory-title">
        <h3 className="group-title" id="progression-victory-title">
          {C.victoryTitle}
        </h3>
        <LedgerTable className="ledger-columns progress-table" testId="progression-victory" caption={C.victoryCaption}>
          <thead>
            <tr>
              <th scope="col">{C.condition}</th>
              <th scope="col" className="figure">
                {C.required}
              </th>
              <th scope="col" className="figure">
                {C.now}
              </th>
              <th scope="col" className="figure">
                {C.status}
              </th>
            </tr>
          </thead>
          <tbody>
            {victoryConditions(snapshot).map((v) => (
              <VictoryRow key={v.kind} condition={v} />
            ))}
          </tbody>
        </LedgerTable>
      </section>

      <section aria-labelledby="progression-ladder-title">
        <h3 className="group-title" id="progression-ladder-title">
          {C.ladderTitle}
        </h3>
        <LedgerTable className="progress-ladder" testId="progression-ladder">
          <thead>
            <tr>
              <th scope="col">{C.tier}</th>
              <th scope="col">{C.needs}</th>
              <th scope="col">{C.unlocks}</th>
            </tr>
          </thead>
          <tbody>
            {progression.tiers.map((tier) => {
              const status = tierStatus(tier, snapshot);
              return (
                <tr key={tier.id} data-status={status} data-testid={`progression-tier-${tier.id}`}>
                  <th scope="row">
                    <span className="progress-tier-name">{tier.name}</span>
                    <span className="progress-tier-status" data-testid={`progression-tier-${tier.id}-status`}>
                      {TIER_STATUS_LABEL[status]}
                    </span>
                  </th>
                  <td data-testid={`progression-tier-${tier.id}-needs`}>{describeNeeds(tier)}</td>
                  <td data-testid={`progression-tier-${tier.id}-unlocks`}>{tier.unlocks.length > 0 ? unlockList(tier.unlocks) : COMMON_COPY.none}</td>
                </tr>
              );
            })}
          </tbody>
        </LedgerTable>
      </section>

      <section aria-labelledby="progression-unlocked-title">
        <h3 className="group-title" id="progression-unlocked-title">
          {C.unlockedTitle}
        </h3>
        <p className="progress-note" data-testid="progression-unlocked">
          {progression.unlocked.length > 0 ? unlockList(progression.unlocked) : C.noUnlocks}
        </p>
      </section>

      <section aria-labelledby="progression-buyers-title">
        <h3 className="group-title" id="progression-buyers-title">
          {C.buyersTitle}
        </h3>
        {gated.length === 0 ? (
          <p className="panel-empty">{C.noGatedBuyers}</p>
        ) : (
          <LedgerTable className="ledger-columns progress-table" testId="progression-buyers">
            <thead>
              <tr>
                <th scope="col">{C.buyer}</th>
                <th scope="col" className="figure">
                  {C.minimum}
                </th>
                <th scope="col" className="figure">
                  {C.willDeal}
                </th>
              </tr>
            </thead>
            <tbody>
              {gated.map((b) => (
                <tr key={b.id} data-testid={`progression-buyer-${b.id}`}>
                  <th scope="row">{b.name}</th>
                  <td className="figure" data-testid={`progression-buyer-${b.id}-minimum`}>
                    <span className="money">{b.minimumReputation}</span>
                  </td>
                  <td className="figure">
                    <span className="progress-status" data-met={b.willDeal} data-testid={`progression-buyer-${b.id}-deals`}>
                      {b.willDeal ? C.willDealYes : C.willDealNo}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </LedgerTable>
        )}
      </section>
    </section>
  );
}

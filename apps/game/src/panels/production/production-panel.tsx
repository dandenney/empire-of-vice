// Production (PROD-001): each facility's recipes with what can start now and
// why not, START_PRODUCTION, and the running jobs.
//
// `maxStartableQuantity` and `blockedBy` are precomputed by the simulation
// (ADR 0007); the panel only shows them. The quantity isn't clamped to the
// maximum, so a request the simulation rejects shows its typed reason. No
// pre-start duration estimate yet (issue #11 decision 11); a later task may
// show `ticksPerCase × quantity`.
//
// The last run can be repeated (REPEAT_OPERATION on the `causedBy` of the
// newest PRODUCTION_STARTED event in the snapshot's recent events, ADR 0020
// decision 11). The simulation re-validates it; a rejection shows its typed
// reason. The offer drops off once that event leaves the recent-events window.

import type { CommandId, FacilitySnapshot, GameSnapshot, ProductionJobSnapshot, RecipeOption } from "@eov/contracts";
import { useState } from "react";
import { describeOutcome, describeReason, formatQuality } from "../../components/format.ts";
import { COMMON_COPY } from "../../components/copy.ts";
import { useCommand } from "../../components/use-command.ts";
import type { PanelProps } from "../registry.ts";
import { PRODUCTION_COPY as C } from "./copy.ts";
import "./production.css";

function RecipeRow({ facility, recipe }: { readonly facility: FacilitySnapshot; readonly recipe: RecipeOption }) {
  const command = useCommand(`start-production:${facility.id}:${recipe.recipeId}`);
  const [quantity, setQuantity] = useState("1");
  const materialName = (id: string) => facility.materials.find((m) => m.materialId === id)?.materialName ?? id;
  const testId = `recipe-${recipe.recipeId}`;

  const start = () =>
    command.send({ command: { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.recipeId, quantity: Number(quantity) } });

  return (
    <li className="recipe" data-testid={testId}>
      <header className="recipe-head">
        <h5 className="recipe-name">{recipe.name}</h5>
        <span className="badge" data-quality={recipe.quality} title={C.quality}>
          {formatQuality(recipe.quality)}
        </span>
      </header>
      <dl className="recipe-facts">
        <div>
          <dt>{C.inputsPerCase}</dt>
          <dd>
            <ul className="inline-list">
              {recipe.inputsPerCase.map((i) => (
                <li key={i.materialId}>{C.inputLine(materialName(i.materialId), i.quantity)}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{C.canStart}</dt>
          <dd className="figure" data-testid={`${testId}-max`}>
            {recipe.maxStartableQuantity}
          </dd>
        </div>
        <div className="recipe-blocked" data-blocked={recipe.blockedBy !== null}>
          <dt>{C.blockedBy}</dt>
          <dd data-testid={`${testId}-blocked`}>{recipe.blockedBy ? describeReason(recipe.blockedBy) : C.notBlocked}</dd>
        </div>
      </dl>
      <div className="recipe-start">
        <label className="field">
          <span className="field-label">{C.quantity}</span>
          <input
            type="number"
            className="input"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-label={C.quantityLabel(recipe.name)}
            data-testid={`${testId}-quantity`}
          />
        </label>
        <button type="button" className="button button-primary" onClick={start} disabled={command.pending || recipe.blockedBy !== null} data-testid={`${testId}-start`}>
          {C.start}
        </button>
        <p role="status" className="command-result" data-testid={`${testId}-result`}>
          {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeOutcome(command.outcome) : ""}
        </p>
      </div>
    </li>
  );
}

/** The player's last production run, from the snapshot's recent events, or null. */
function lastRun(snapshot: GameSnapshot): { readonly sourceCommandId: CommandId; readonly line: string } | null {
  let last: { readonly sourceCommandId: CommandId; readonly line: string } | null = null;
  for (const event of snapshot.recentEvents) {
    if (event.type !== "PRODUCTION_STARTED" || event.causedBy === null) continue;
    const facility = snapshot.facilities.find((f) => f.id === event.facilityId);
    const recipe = facility?.recipes.find((r) => r.recipeId === event.recipeId)?.name ?? event.recipeId;
    last = { sourceCommandId: event.causedBy, line: C.repeatLine(event.quantity, recipe, facility?.name ?? event.facilityId) };
  }
  return last;
}

function RepeatRun({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const command = useCommand("repeat-production");
  const run = lastRun(snapshot);
  if (run === null) return null;
  const repeat = () => command.send({ command: { type: "REPEAT_OPERATION", sourceCommandId: run.sourceCommandId } });
  return (
    <section aria-labelledby="production-repeat-title" data-testid="repeat-production">
      <h3 className="group-title" id="production-repeat-title">
        {C.repeatTitle}
      </h3>
      <div className="recipe">
        <p className="recipe-name" data-testid="repeat-production-line">
          {run.line}
        </p>
        <p className="facility-summary">{C.repeatNote}</p>
        <div className="recipe-start">
          <button type="button" className="button button-primary" onClick={repeat} disabled={command.pending} aria-label={C.repeatLabel(run.line)} data-testid="repeat-production-button">
            {C.repeat}
          </button>
          <p role="status" className="command-result" data-testid="repeat-production-result">
            {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeOutcome(command.outcome) : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

function JobItem({ job, facility, tick }: { readonly job: ProductionJobSnapshot; readonly facility: FacilitySnapshot; readonly tick: number }) {
  const recipe = facility.recipes.find((r) => r.recipeId === job.recipeId)?.name ?? job.recipeId;
  return (
    <li className="job" data-testid={`job-${job.id}`}>
      <span className="job-summary">{C.jobSummary(C.jobLine(job.quantity, recipe, formatQuality(job.quality)), C.jobTiming(job.startedAt, job.completesAt))}</span>{" "}
      <progress
        className="progress"
        max={job.completesAt - job.startedAt}
        value={Math.min(Math.max(tick - job.startedAt, 0), job.completesAt - job.startedAt)}
        aria-label={C.jobProgressLabel(recipe)}
        data-testid={`job-${job.id}-progress`}
      />
    </li>
  );
}

function FacilitySection({ facility, snapshot }: { readonly facility: FacilitySnapshot; readonly snapshot: GameSnapshot }) {
  const jobs = snapshot.productionJobs.filter((j) => j.facilityId === facility.id);
  return (
    <section className="facility" data-testid={`facility-${facility.id}`} aria-labelledby={`facility-${facility.id}-title`}>
      <h3 className="section-title" id={`facility-${facility.id}-title`}>
        {facility.name}
      </h3>
      <p className="facility-summary">
        {C.facilitySummary(
          C.capacity(facility.productionCapacityPerDay),
          C.storage(facility.storage.used, facility.storage.capacity),
          C.workforce(facility.workforce.workers, facility.workforce.maximum),
        )}
      </p>
      <div className="stock">
        <div className="stock-group">
          <h4 className="group-title">{C.materials}</h4>
          {facility.materials.length === 0 ? (
            <p className="panel-empty">{C.noMaterials}</p>
          ) : (
            <ul className="ruled-list" data-testid={`facility-${facility.id}-materials`}>
              {facility.materials.map((m) => (
                <li key={m.materialId}>{C.materialLine(m.materialName, m.quantity, m.reservedQuantity)}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="stock-group">
          <h4 className="group-title">{C.products}</h4>
          {facility.products.length === 0 ? (
            <p className="panel-empty">{C.noProducts}</p>
          ) : (
            <ul className="ruled-list" data-testid={`facility-${facility.id}-products`}>
              {facility.products.map((p) => (
                <li key={`${p.productId}:${p.quality}`}>{C.productLine(p.productName, formatQuality(p.quality), p.quantity, p.reservedQuantity)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h4 className="group-title">{C.recipes}</h4>
      <ul className="recipes">
        {facility.recipes.map((r) => (
          <RecipeRow key={r.recipeId} facility={facility} recipe={r} />
        ))}
      </ul>
      <h4 className="group-title">{C.jobs}</h4>
      {jobs.length === 0 ? (
        <p className="panel-empty" data-testid={`facility-${facility.id}-no-jobs`}>
          {C.noJobs}
        </p>
      ) : (
        <ul className="ruled-list" data-testid={`facility-${facility.id}-jobs`}>
          {jobs.map((j) => (
            <JobItem key={j.id} job={j} facility={facility} tick={snapshot.clock.tick} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProductionPanel({ snapshot }: PanelProps) {
  const facilities = snapshot.facilities.filter((f) => f.recipes.length > 0);
  return (
    <section className="panel" data-testid="panel-production" aria-labelledby="production-title">
      <h2 className="panel-title" id="production-title">
        {C.title}
      </h2>
      <RepeatRun snapshot={snapshot} />
      {facilities.length === 0 ? <p className="panel-empty">{C.noFacilities}</p> : facilities.map((f) => <FacilitySection key={f.id} facility={f} snapshot={snapshot} />)}
    </section>
  );
}

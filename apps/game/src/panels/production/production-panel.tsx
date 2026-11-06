// Production (PROD-001): each facility's recipes with what can start now and
// why not, START_PRODUCTION, and the running jobs.
//
// `maxStartableQuantity` and `blockedBy` are precomputed by the simulation
// (ADR 0007); the panel only shows them. The quantity isn't clamped to the
// maximum, so a request the simulation rejects shows its typed reason. No
// pre-start duration estimate yet (issue #11 decision 11); a later task may
// show `ticksPerCase × quantity`.

import type { FacilitySnapshot, GameSnapshot, ProductionJobSnapshot, RecipeOption } from "@eov/contracts";
import { useState } from "react";
import { describeOutcome, describeReason, formatQuality } from "../../components/format.ts";
import { COMMON_COPY } from "../../components/copy.ts";
import { useCommand } from "../../components/use-command.ts";
import type { PanelProps } from "../registry.ts";
import { PRODUCTION_COPY as C } from "./copy.ts";

function RecipeRow({ facility, recipe }: { readonly facility: FacilitySnapshot; readonly recipe: RecipeOption }) {
  const command = useCommand(`start-production:${facility.id}:${recipe.recipeId}`);
  const [quantity, setQuantity] = useState("1");
  const materialName = (id: string) => facility.materials.find((m) => m.materialId === id)?.materialName ?? id;
  const testId = `recipe-${recipe.recipeId}`;

  const start = () =>
    command.send({ command: { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.recipeId, quantity: Number(quantity) } });

  return (
    <tr data-testid={testId}>
      <th scope="row">{recipe.name}</th>
      <td>{formatQuality(recipe.quality)}</td>
      <td>
        <ul>
          {recipe.inputsPerCase.map((i) => (
            <li key={i.materialId}>{C.inputLine(materialName(i.materialId), i.quantity)}</li>
          ))}
        </ul>
      </td>
      <td data-testid={`${testId}-max`}>{recipe.maxStartableQuantity}</td>
      <td data-testid={`${testId}-blocked`}>{recipe.blockedBy ? describeReason(recipe.blockedBy) : C.notBlocked}</td>
      <td>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-label={C.quantityLabel(recipe.name)}
          data-testid={`${testId}-quantity`}
        />
        <button type="button" onClick={start} disabled={command.pending || recipe.blockedBy !== null} data-testid={`${testId}-start`}>
          {C.start}
        </button>
        <p role="status" data-testid={`${testId}-result`}>
          {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeOutcome(command.outcome) : ""}
        </p>
      </td>
    </tr>
  );
}

function JobItem({ job, facility, tick }: { readonly job: ProductionJobSnapshot; readonly facility: FacilitySnapshot; readonly tick: number }) {
  const recipe = facility.recipes.find((r) => r.recipeId === job.recipeId)?.name ?? job.recipeId;
  return (
    <li data-testid={`job-${job.id}`}>
      {C.jobSummary(C.jobLine(job.quantity, recipe, formatQuality(job.quality)), C.jobTiming(job.startedAt, job.completesAt))}{" "}
      <progress
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
    <section data-testid={`facility-${facility.id}`} aria-labelledby={`facility-${facility.id}-title`}>
      <h3 id={`facility-${facility.id}-title`}>{facility.name}</h3>
      <p>
        {C.facilitySummary(
          C.capacity(facility.productionCapacityPerDay),
          C.storage(facility.storage.used, facility.storage.capacity),
          C.workforce(facility.workforce.workers, facility.workforce.maximum),
        )}
      </p>
      <h4>{C.materials}</h4>
      {facility.materials.length === 0 ? (
        <p>{C.noMaterials}</p>
      ) : (
        <ul data-testid={`facility-${facility.id}-materials`}>
          {facility.materials.map((m) => (
            <li key={m.materialId}>{C.materialLine(m.materialName, m.quantity, m.reservedQuantity)}</li>
          ))}
        </ul>
      )}
      <h4>{C.products}</h4>
      {facility.products.length === 0 ? (
        <p>{C.noProducts}</p>
      ) : (
        <ul data-testid={`facility-${facility.id}-products`}>
          {facility.products.map((p) => (
            <li key={`${p.productId}:${p.quality}`}>{C.productLine(p.productName, formatQuality(p.quality), p.quantity, p.reservedQuantity)}</li>
          ))}
        </ul>
      )}
      <table>
        <caption>{C.recipes}</caption>
        <thead>
          <tr>
            <th scope="col">{C.recipe}</th>
            <th scope="col">{C.quality}</th>
            <th scope="col">{C.inputsPerCase}</th>
            <th scope="col">{C.canStart}</th>
            <th scope="col">{C.blockedBy}</th>
            <th scope="col">{C.quantity}</th>
          </tr>
        </thead>
        <tbody>
          {facility.recipes.map((r) => (
            <RecipeRow key={r.recipeId} facility={facility} recipe={r} />
          ))}
        </tbody>
      </table>
      <h4>{C.jobs}</h4>
      {jobs.length === 0 ? (
        <p data-testid={`facility-${facility.id}-no-jobs`}>{C.noJobs}</p>
      ) : (
        <ul data-testid={`facility-${facility.id}-jobs`}>
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
    <section data-testid="panel-production" aria-labelledby="production-title">
      <h2 id="production-title">{C.title}</h2>
      {facilities.length === 0 ? <p>{C.noFacilities}</p> : facilities.map((f) => <FacilitySection key={f.id} facility={f} snapshot={snapshot} />)}
    </section>
  );
}

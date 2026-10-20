/**
 * Tool calls -> operator overrides. Exclusions add to what the operator
 * already excluded; set_* calls replace the value. Nothing else on the
 * operator inputs is touched.
 */
import type { OperatorInputs } from "@walkup/contracts";
import type { ReviseCall } from "@walkup/narrator";

/** The operator fields a revision changes, merged over the parent's. */
export function overridesFor(calls: readonly ReviseCall[], parent: OperatorInputs): Partial<OperatorInputs> {
  const out: Partial<OperatorInputs> = {};
  for (const c of calls) {
    switch (c.tool) {
      case "set_all_ages":
        out.allAges = c.input.allAges;
        break;
      case "exclude_partner_categories":
        out.excludeCategories = [...new Set([...(out.excludeCategories ?? parent.excludeCategories ?? []), ...c.input.categories])];
        break;
      case "exclude_areas":
        out.excludeAreas = [...new Set([...(out.excludeAreas ?? parent.excludeAreas ?? []), ...c.input.areas])];
        break;
      case "set_street_team_days":
        out.streetTeamDays = [...c.input.days];
        break;
      case "set_radius":
        out.radiusKm = c.input.km;
        break;
      case "ask_operator":
        break;
    }
  }
  return out;
}

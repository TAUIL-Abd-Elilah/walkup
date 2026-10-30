/**
 * Round 7, engine: "No restaurants" also leaves out a place whose name says restaurant (a wine bar named "La Parra
 * Restaurant & Bar"), never a bar only for its generic restaurant tag; a department-store tag alone is not a clothing
 * store (Qloo tags supermarkets with it). Synthetic data.
 */
import { describe, expect, it } from "vitest";
import { categoryFromTags, eligiblePartnerIds, nameSaysRestaurant, restaurantsExcluded } from "../src/index";
import { place, tag } from "./helpers";

const t = (key: string) => tag(`urn:tag:category:place:${key}`, key);

describe('"No restaurants" by name', () => {
  const laParra = place("La Parra Restaurant & Bar", { id: "E-parra", tags: [t("wine_bar"), t("bar"), t("restaurant"), t("mediterranean_restaurant")] });
  const corkKerry = place("Cork & Kerry at The Park", { id: "E-cork", tags: [t("sports_bar"), t("irish_pub"), t("restaurant")] });

  it("reads restaurant in a name", () => {
    expect(nameSaysRestaurant("La Parra Restaurant & Bar")).toBe(true);
    expect(nameSaysRestaurant("Right Spot Restaurant & Bar")).toBe(true);
    expect(nameSaysRestaurant("Cork & Kerry at The Park")).toBe(false);
    expect(restaurantsExcluded(["restaurant"])).toBe(true);
    expect(restaurantsExcluded(["bar", "cafe"])).toBe(false);
  });

  it("drops the place named restaurant, keeps the sports bar with a generic restaurant tag", () => {
    expect(categoryFromTags(laParra)).toBe("wine_bar");
    expect(eligiblePartnerIds([laParra, corkKerry], { excludeCategories: ["restaurant"] })).toEqual(["E-cork"]);
    expect(eligiblePartnerIds([laParra, corkKerry], {})).toEqual(["E-parra", "E-cork"]);
  });
});

describe("a department-store tag alone", () => {
  it("is not a clothing store; a store with a clothing tag still is", () => {
    const walmart = place("Walmart Neighborhood Market", { tags: [t("discount_supermarket"), t("grocery_store"), t("department_store"), t("bakery"), t("cake_shop"), t("deli")] });
    const ross = place("Ross Dress for Less", { tags: [t("department_store"), t("clothing_store"), t("shoe_store")] });
    expect(categoryFromTags(walmart)).toBe("bakery");
    expect(categoryFromTags(ross)).toBe("clothing_store");
  });
});

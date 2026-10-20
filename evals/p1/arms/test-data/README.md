# Synthetic test data for the P1 arm runner

`bars_synthetic.csv` has the column layout of the private ground-truth table
(`data/private/p1/bars_full.csv`) and **only invented rows**: every bar name, address, source
URL and bar key is made up, and the metros "Exampleton" and "Sampleville" do not exist
(Durham, NC is used only so the viability-gate selection has a real metro name to match).
Nothing here comes from a club page, Qloo, Google Places, the Census Geocoder or a model.

The rows are built to exercise every exclusion in the plan's order (stale page, no metro,
unresolved, closed, out of radius, analyzed), both resolution paths, the ZIP rule, rival rows
and the Derby shortlist. The fake transports in `../test/fake-world.ts` answer for them.

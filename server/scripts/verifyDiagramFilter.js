// ----------------------------------------------------------------------------
// verifyDiagramFilter.js — zero-cost gate for the diagram §3 year/generation
// guard + narrow component precision. Pure (no API/DB) — feeds synthetic Brave
// results (modeled on the real probe data) through the real filter and asserts:
//   - fuse: a wrong-GENERATION fuse box is SUPPRESSED (-> fallback), the
//           year-correct one PASSES.
//   - component: a wrong-year belt diagram + parts-store product photos are
//           SUPPRESSED; only a year-verified trustworthy source PASSES.
// Run: node scripts/verifyDiagramFilter.js
// ----------------------------------------------------------------------------

import { filterResults, yearVerified } from "../diagramLookup.js";

const R = (title, url) => ({ title, url, thumbnail: { src: url + "#thumb" } });
let fails = 0;
const ok = (cond, label) => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); };

// ---- yearVerified unit checks ----
ok(yearVerified("Honda CR-V (2017, 2018, 2019, 2020, 2021, 2022)", 2020), "yearVerified: comma list incl 2020");
ok(yearVerified("Ford F-150 (2015-2018)", 2017), "yearVerified: range 2015-2018 incl 2017");
ok(!yearVerified("Honda CR-V (2015, 2016)", 2020), "yearVerified: 2020 NOT in {2015,2016}");
ok(!yearVerified("Under-hood fuse box: Honda CR-V", 2020), "yearVerified: no year present -> false");
ok(yearVerified("serpentine-belt-diagram-2009-toyota-camry-v6", 2009), "yearVerified: year in URL slug");

// ---- FUSE: 2020 CR-V — probe showed only wrong-gen results -> all suppressed ----
const fuse2020crv = filterResults([
  R("Under-hood fuse box diagram: Honda CR-V (2000, 2001)", "https://fuse-box.info/honda/honda-cr-v-1995-2001-fuses"),
  R("Under-hood fuse box diagram: Honda CR-V (2015, 2016)", "https://fuse-box.info/honda/honda-cr-v-2012-2016-fuses"),
  R("Under-hood fuse box diagram: Honda CR-V (2010, 2011)", "https://fuse-box.info/honda/honda-cr-v-2007-2011-fuses"),
], { year: 2020, make: "Honda", model: "CR-V" }, "fuse");
ok(fuse2020crv.length === 0, `FUSE wrong-gen 2020 CR-V SUPPRESSED -> fallback (got ${fuse2020crv.length} images)`);

// ---- FUSE: year-correct CR-V passes ----
const fuse2020crvOk = filterResults([
  R("Under-hood fuse box diagram: Honda CR-V (2017, 2018, 2019, 2020, 2021, 2022)", "https://fuse-box.info/honda/honda-cr-v-2017-2022-fuses"),
], { year: 2020, make: "Honda", model: "CR-V" }, "fuse");
ok(fuse2020crvOk.length === 1, `FUSE year-correct 2020 CR-V PASSES (got ${fuse2020crvOk.length})`);

// ---- FUSE: 2019 F-150 year-correct passes; social junk dropped ----
const fuseF150 = filterResults([
  R("Under-hood fuse box diagram: Ford F-150 (2018, 2019)", "https://fuse-box.info/ford/ford-f-150-2015-2018-fuses-and-relay"),
  R("F-150 fuse box pin", "https://www.pinterest.com/pin/12345"),
], { year: 2019, make: "Ford", model: "F-150" }, "fuse");
ok(fuseF150.length === 1 && fuseF150[0].domain.includes("fuse-box.info"), `FUSE 2019 F-150 passes, pinterest dropped (got ${fuseF150.length})`);

// ---- COMPONENT (narrow): 2018 Camry — wrong-year + product photos suppressed; year-keyed OEM catalog passes ----
const comp2018camry = filterResults([
  R("34 2005 Toyota Camry Serpentine Belt Diagram", "https://zen-lace.blogspot.com/2005-camry"),           // wrong year -> drop
  R("Goodyear Belts 1070563 Serpentine Belt for Toyota Camry 2018", "https://www.amazon.com/dp/x"),         // product/deny host+title
  R("How to Replace Serpentine Belt 2018 Toyota Camry", "https://www.go-parts.com/garage/camry"),            // video/deny
  R("Diagram BELTS & PULLEYS. for your 2018 TOYOTA CAMRY", "https://parts.lakelandtoyota.com/p/toyota_2018_CAMRY/Serpentine-Belt/x.html"), // year-keyed OEM -> PASS
], { year: 2018, make: "Toyota", model: "Camry" }, "component");
ok(comp2018camry.length === 1 && comp2018camry[0].domain.includes("lakelandtoyota"),
  `COMPONENT 2018 Camry: only year-verified OEM catalog PASSES, wrong-year+products SUPPRESSED (got ${comp2018camry.length})`);

// ---- COMPONENT: dedicated diagram host with year in URL passes; year-agnostic dropped ----
const compCamry09 = filterResults([
  R("", "http://www.serpentinebeltdiagram.com/serpentine-belt-diagram-2009-toyota-camry-v6-35-liter-engine-06999/"),
], { year: 2009, make: "Toyota", model: "Camry" }, "component");
ok(compCamry09.length === 1, `COMPONENT 2009 Camry dedicated host (year in URL) PASSES (got ${compCamry09.length})`);

const compNoYear = filterResults([
  R("Toyota Camry serpentine belt diagram", "https://serpentinebeltdiagram.com/toyota-camry"),
], { year: 2018, make: "Toyota", model: "Camry" }, "component");
ok(compNoYear.length === 0, `COMPONENT no-year-anywhere SUPPRESSED -> fallback (got ${compNoYear.length})`);

console.log(fails === 0 ? `\nverifyDiagramFilter: ALL PASSED` : `\nverifyDiagramFilter: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

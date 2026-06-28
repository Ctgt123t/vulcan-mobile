// Curated common US passenger + light-truck makes (≈1990–present) shown as the
// default /api/makes response so the make picker isn't a 12,266-row dropdown.
// EVERY name was verified to exist in vpic.make (2026-06-28) so the picker emits
// canonical spelling that joins the public spec rows via canonicalVehicle.js.
//
// Casing note: the spec join is case-insensitive (canonicalizeMake passthrough +
// lower() on both sides), so these display-clean TitleCase names join regardless
// of how vpic.make stores them. Three exist in vpic.make under a different case
// (Rivian→"RIVIAN", Saab→"SAAB", Smart→"smart") — kept with clean display
// spelling; the join is unaffected. "Scion" was DROPPED — it isn't a make in
// vpic.make at all (vPIC decodes Scion VINs under Toyota); free-text covers it.
export const COMMON_MAKES = [
  "Acura", "Alfa Romeo", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet",
  "Chrysler", "Dodge", "Fiat", "Ford", "Genesis", "GMC", "Honda", "Hummer",
  "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus",
  "Lincoln", "Lucid", "Maserati", "Mazda", "Mercedes-Benz", "Mercury", "MINI",
  "Mitsubishi", "Nissan", "Oldsmobile", "Plymouth", "Polestar", "Pontiac",
  "Porsche", "Ram", "Rivian", "Saab", "Saturn", "Smart", "Subaru", "Suzuki",
  "Tesla", "Toyota", "Volkswagen", "Volvo",
];

import { Redirect } from "expo-router";

// Phase 4 (unified shell): Ask Vulcan lives inside the unified chat at /chat
// (the default LIGHT phase). This stub keeps the old route + any stale deep
// links working. The full Ask implementation was ported into app/chat.tsx;
// the AddVehicleModal was extracted to components/AddVehicleModal.tsx.
export default function AskRedirect() {
  return <Redirect href="/chat" />;
}

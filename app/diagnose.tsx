import { Redirect, useLocalSearchParams } from "expo-router";

// Phase 4 (unified shell): the diagnostic screen lives at /chat (the file was
// renamed diagnose.tsx → chat.tsx; the engine and screen machinery are
// unchanged). This stub keeps the old route + any stale deep links working —
// a plain /diagnose entry lands on the intake (mode=diagnose), and
// /diagnose?resume=<id> resumes the case exactly as before.
export default function DiagnoseRedirect() {
  const params = useLocalSearchParams<{ resume?: string; focusVin?: string }>();
  const resume = typeof params.resume === "string" ? params.resume : null;
  const focusVin =
    typeof params.focusVin === "string" ? params.focusVin : null;
  if (resume) {
    return <Redirect href={{ pathname: "/chat", params: { resume } }} />;
  }
  if (focusVin) {
    return (
      <Redirect
        href={{ pathname: "/chat", params: { mode: "diagnose", focusVin } }}
      />
    );
  }
  return <Redirect href={{ pathname: "/chat", params: { mode: "diagnose" } }} />;
}

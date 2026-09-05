import type { Metadata } from "next";
import QueryConsole from "./QueryConsole";

export const metadata: Metadata = { title: "Zone History · Query" };

// The console is a client component and reaches DuckDB-WASM only through a
// lazy import that runs after mount, so the static HTML carries the loading
// state and the map's bundle carries nothing from it.
export default function QueryPage() {
  return <QueryConsole />;
}

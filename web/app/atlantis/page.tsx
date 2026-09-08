import type { Metadata } from "next";
import { Suspense } from "react";
import AtlantisPage from "./AtlantisPage";

export const metadata: Metadata = { title: "Zone History · Atlantis" };

export default function Page() {
  return (
    <Suspense>
      <AtlantisPage />
    </Suspense>
  );
}

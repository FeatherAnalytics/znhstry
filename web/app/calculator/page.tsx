import type { Metadata } from "next";
import CalculatorPage from "./CalculatorPage";

export const metadata: Metadata = { title: "Zone History · Calculator" };

export default function Page() {
  return <CalculatorPage />;
}

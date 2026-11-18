"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SiteNav } from "@/components/SiteNav";
import { BASE } from "@/lib/dataOrigin";
import { loadJson } from "@/lib/format";
import { CUBE_PACKS, FORMATIONS, cheapestPurchase, planLaunches, type DepotExport, type LaunchPlan, type Purchase } from "@/lib/depot";

const count = (n: number): string => Math.floor(n).toLocaleString("en-US");

/** Blank and junk read as zero so a half-typed field never blanks the results. */
const parseCount = (text: string): number => {
  const n = Number(text.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const STYLES = `
.calc { max-width: 880px; padding: 20px 16px 32px; }
.calc-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.calc-field { display: flex; flex-direction: column; gap: 4px; color: var(--text-dim); min-width: 0; }
.calc-input { background: var(--ink-raised); border: 1px solid var(--hairline-bright); border-radius: 3px; color: var(--text); padding: 6px 8px; width: 100%; min-width: 0; }
.calc-input:focus-visible { outline: 1px solid var(--text); outline-offset: 1px; }
.calc-total { margin: 28px 0 0; font-size: 32px; line-height: 1.1; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.calc-steps { margin: 16px 0 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr auto; gap: 6px 0; max-width: 520px; font-variant-numeric: tabular-nums; }
.calc-steps li { display: contents; }
.calc-steps span:first-child { color: var(--text-dim); }
.calc-steps span:last-child { text-align: right; padding-left: 24px; }
.calc-steps .calc-sum span { padding-top: 6px; border-top: 1px solid var(--hairline-bright); color: var(--text); }
.calc-steps .calc-sum + .calc-sum span { padding-top: 0; border-top: none; }
.calc-buy { margin-top: 20px; }
@media (max-width: 640px) { .calc-input { font-size: 16px; } }
`;

function useDepot(): DepotExport | null {
  const [depot, setDepot] = useState<DepotExport | null>(null);
  useEffect(() => {
    let live = true;
    loadJson<DepotExport>(`${BASE}/depot.json.br`)
      .then((loaded) => live && setDepot(loaded))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return depot;
}

function RateSelect({ depot, value, onChange }: { depot: DepotExport | null; value: number; onChange: (rate: number) => void }) {
  return (
    <select className="calc-input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {(depot?.rates_seen ?? []).map((rate) => (
        <option key={rate} value={rate}>{count(rate)}</option>
      ))}
    </select>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="calc-field">
      {name}
      {children}
    </label>
  );
}

function NumberInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input className="calc-input" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function Step({ what, cost, sum }: { what: string; cost: string; sum?: boolean }) {
  return (
    <li className={sum ? "calc-sum" : undefined}>
      <span>{what}</span>
      <span>{cost}</span>
    </li>
  );
}

interface BreakdownProps {
  plan: LaunchPlan;
  launches: number;
  shortfall: number;
  exchangeCubes: number;
  rate: number;
  total: number;
}

function exchangeStep({ shortfall, exchangeCubes, rate }: BreakdownProps): { what: string; cost: string } {
  const cost = shortfall > 0 && rate === 0 ? "rate unavailable" : `${count(exchangeCubes)} Cubes`;
  return { what: "Cubes converted to Qredits", cost };
}

function Breakdown(props: BreakdownProps) {
  const { plan, launches } = props;
  return (
    <ul className="calc-steps">
      {plan.refreshes > 0 && <Step what={`${count(plan.refreshes)} nanobot refreshes`} cost={`${count(plan.refreshCubes)} Cubes`} />}
      <Step what={`${count(plan.recharges)} energy recharges`} cost={`${count(plan.rechargeCubes)} Cubes`} />
      {plan.ordnance && (
        <>
          <Step what={`${count(launches)} ${plan.ordnance.name}`} cost={`${count(plan.qredits)} Qredits`} />
          <Step {...exchangeStep(props)} />
          <Step sum what="Total Qredits used" cost={`${count(plan.qredits)} Qredits`} />
        </>
      )}
      <Step sum what="Total Cubes used" cost={`${count(props.total)} Cubes`} />
    </ul>
  );
}

const dollars = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const packList = (purchase: Purchase): string =>
  [...purchase.counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([i, n]) => `${count(n)} × ${dollars(CUBE_PACKS[i].cents)}`)
    .join(", ");

function CubePurchase({ total }: { total: number }) {
  if (total === 0) return null;
  const regular = cheapestPurchase(total, false);
  const subscriber = cheapestPurchase(total, true);
  return (
    <ul className="calc-steps calc-buy">
      <Step what={`Buy ${count(regular.cubes)} Cubes: ${packList(regular)}`} cost={dollars(regular.cents)} />
      <Step what={`Subscriber, ${count(subscriber.cubes)} Cubes: ${packList(subscriber)}`} cost={dollars(subscriber.cents)} />
    </ul>
  );
}

export default function CalculatorPage() {
  const depot = useDepot();
  const [chosenRate, setChosenRate] = useState<number | null>(null);
  const [formationName, setFormationName] = useState(FORMATIONS[0].name);
  const [launchText, setLaunchText] = useState("100");
  const [qreditText, setQreditText] = useState("0");

  const rate = chosenRate ?? depot?.exchange_rate?.qredits_per_cube ?? 0;
  const launches = parseCount(launchText);
  const formation = FORMATIONS.find((f) => f.name === formationName) ?? FORMATIONS[0];
  const plan = planLaunches(formation, launches);
  const shortfall = Math.max(0, plan.qredits - parseCount(qreditText));
  const exchangeCubes = rate > 0 ? Math.ceil(shortfall / rate) : 0;
  const total = plan.refreshCubes + plan.rechargeCubes + exchangeCubes;

  return (
    <main style={{ minHeight: "100dvh", background: "var(--ink)", overflowX: "hidden" }}>
      <style>{STYLES}</style>
      <header style={{ display: "flex", flexDirection: "column", gap: 3, padding: "12px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <h1 className="display" style={{ margin: 0, fontSize: 18 }}>Calculator</h1>
        <SiteNav />
      </header>
      <div className="calc">
        <div className="calc-fields">
          <Field name="Formation">
            <select className="calc-input" value={formationName} onChange={(e) => setFormationName(e.target.value)}>
              {FORMATIONS.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </Field>
          <Field name="Launches">
            <NumberInput value={launchText} onChange={setLaunchText} />
          </Field>
          {plan.ordnance && (
            <>
              <Field name="Qredits you have">
                <NumberInput value={qreditText} onChange={setQreditText} />
              </Field>
              <Field name="Qredits per Cube">
                <RateSelect depot={depot} value={rate} onChange={setChosenRate} />
              </Field>
            </>
          )}
        </div>

        <p className="calc-total">{count(total)} Cubes</p>
        <Breakdown plan={plan} launches={launches} shortfall={shortfall} exchangeCubes={exchangeCubes} rate={rate} total={total} />
        <CubePurchase total={total} />
      </div>
    </main>
  );
}

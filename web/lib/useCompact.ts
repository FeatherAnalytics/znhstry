"use client";

import { useEffect, useState } from "react";

/**
 * Width, not device.
 *
 * The compact layout is a response to how much room there is, so a narrow
 * desktop window gets it too and there is no cliff between "phone" and "not
 * phone". 900px is where the header's controls, a 268px stats panel and a
 * readable map stop fitting side by side.
 */
const COMPACT_MAX = 900;

export function useCompact(): boolean {
  // Starts false so the server render and the first client render agree; a
  // phone corrects it on the first effect, one frame in.
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COMPACT_MAX}px)`);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return compact;
}

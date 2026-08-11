/**
 * Chart colors.
 *
 * One declaration, because three files were carrying the same hex literal and a
 * fourth was about to. A color that means something - and this one does - is a
 * fact about the data, so it belongs in one place for the same reason a zone's
 * name does.
 *
 * **Amber is the MAZ color, and it is amber precisely because it is none of the
 * three faction colors.** A MAZ is not a faction fact: it says this zone was
 * among the most active in the world that day, which is a statement about
 * attention rather than about who holds the ground. The map's MAZ rings wear it
 * and the bench's charts follow, so a reader who has seen one recognizes the
 * other.
 *
 * Note the dataviz validator FAILs this hex on its dark-mode lightness band
 * (L 0.861 against a 0.48-0.67 band). That check is scoped to *categorical
 * palettes* - a set of colors that have to be told apart from one another - and
 * does not apply to a single series. Contrast against the surface passes.
 * **If a categorical MAZ palette is ever needed, re-run the validator rather
 * than extending this amber into a series set.**
 */

export const MAZ_AMBER = "#ffc857";

/**
 * The three faction colors, read from the same custom properties the map uses.
 *
 * **This is the one chart subject where the faction colors are correct rather
 * than reserved.** Everything else on the bench is amber precisely because it is
 * not a faction fact; a faction's share of the launches on a zone is nothing
 * else. Recoloring it to a validated categorical set would make the chart
 * disagree with the map a reader just came from, and identity matching across
 * two views beats palette hygiene within one.
 *
 * They are taken as tokens, not hexes, so there is still exactly one definition
 * of each - `globals.css`. The literals below are only for a canvas or a
 * validator run, which cannot resolve a custom property.
 *
 * The validator FAILs them on the dark-mode lightness band - legion 0.673 and
 * swarm 0.757 against a 0.48-0.67 band - and passes everything else: chroma,
 * contrast against the surface, a normal-vision separation of 36.6, and CVD
 * separation of 8.1 on the worst adjacent pair. 8.1 clears the target but sits
 * on the floor, so **every chart using these carries direct labels** rather than
 * relying on hue alone. `globals.css` says it plainly: the faction colors are
 * deliberately not harmonised, because they are the game's and they are enemies.
 */
export const FACTIONS = [
  { key: "legion", label: "Legion", token: "var(--legion)", hex: "#ff4d4d" },
  { key: "swarm", label: "Swarm", token: "var(--swarm)", hex: "#22d07e" },
  { key: "faceless", label: "Faceless", token: "var(--faceless)", hex: "#9b6dff" },
] as const;

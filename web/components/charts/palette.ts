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

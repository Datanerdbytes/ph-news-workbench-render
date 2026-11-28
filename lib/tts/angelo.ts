/**
 * SSML builder for the authoritative Filipino news-anchor delivery.
 *
 * Everything narrated through /api/tts is spoken by `fil-PH-AngeloNeural`
 * with broadcast prosody, Philippine acronym spell-outs and news pauses.
 */

export const ANGELO_NEWS_VOICE_ID = "fil-PH-AngeloNeural";
export const ANGELO_NEWS_LOCALE = "fil-PH";

/** Baseline speaking rate of the news anchor: +8% at speed 1. */
export const ANGELO_NEWS_BASE_RATE = 1.08;

const PARAGRAPH_PAUSE = '<break time="450ms"/>';
const COLON_PAUSE = '<break time="250ms"/>';

/**
 * Philippine news acronyms and place names that must not be read literally.
 * Keys are matched whole-word and case-insensitively; values are what the
 * voice actually says. Extend via the `replacements` option or by editing
 * this dictionary.
 */
export const PH_NEWS_PRONUNCIATIONS: Record<string, string> = {
  // Government agencies, spoken letter by letter
  MMDA: "M-M-D-A",
  PNP: "P-N-P",
  DOH: "D-O-H",
  DPWH: "D-P-W-H",
  NDRRMC: "N-D-R-R-M-C",
  BIR: "B-I-R",
  DTI: "D-T-I",
  NBI: "N-B-I",
  DSWD: "D-S-W-D",
  LTFRB: "L-T-F-R-B",
  // Names spoken as words
  EDSA: "Edsa",
  PAGASA: "Pag-asa",
  DEPED: "Dep-Ed",
};

export type AngeloNewsSsmlOptions = {
  /** User speed (0.75–1.25); folded into the rate around the +8% anchor. */
  speed?: number;
  /** Extra or overriding pronunciations merged over the defaults. */
  replacements?: Record<string, string>;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rateValueForSpeed(speed: number): string {
  const rate = Math.round((ANGELO_NEWS_BASE_RATE * speed - 1) * 100);
  return `${rate >= 0 ? "+" : ""}${rate}%`;
}

export function buildAngeloNewsSSML(
  text: string,
  options: AngeloNewsSsmlOptions = {},
): string {
  const speed =
    typeof options.speed === "number" && Number.isFinite(options.speed)
      ? options.speed
      : 1;
  const pronunciations: Record<string, string> = {
    ...PH_NEWS_PRONUNCIATIONS,
    ...Object.fromEntries(
      Object.entries(options.replacements ?? {}).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ]),
    ),
  };

  // Whole-word, case-insensitive spell-outs in a single pass so overlapping
  // entries can never double-replace.
  const keys = Object.keys(pronunciations).sort((a, b) => b.length - a.length);
  const spelledOut = keys.length
    ? text.replace(
        new RegExp(`\\b(${keys.join("|")})\\b`, "gi"),
        (match) => pronunciations[match.toUpperCase()] ?? match,
      )
    : text;

  const escaped = escapeXml(spelledOut);

  // Broadcast pauses: blank lines breathe like paragraph transitions, and
  // colons lead into the next beat — except in times/ratios such as 10:30.
  const withParagraphPauses = escaped.replace(/\n\s*\n/g, PARAGRAPH_PAUSE);
  const withColonPauses = withParagraphPauses.replace(
    /:(?!\d)/g,
    `: ${COLON_PAUSE}`,
  );

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${ANGELO_NEWS_LOCALE}">
  <voice name="${ANGELO_NEWS_VOICE_ID}">
    <prosody rate="${rateValueForSpeed(speed)}" pitch="-3%" volume="+10%">
      ${withColonPauses}
    </prosody>
  </voice>
</speak>`;
}

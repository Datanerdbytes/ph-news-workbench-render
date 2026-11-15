// The connect-gate hint for every platform composer, in one leaf module so
// the four pages share one source of truth and cannot drift apart. Same
// shape throughout: name the account that has to be connected, then the
// mechanism it unlocks.
//
// Kept free of React and of any component import so the platform pages can
// read it without pulling in the composer shell (their tests mock that
// module out).
export const GATE_HINTS = {
  facebook:
    'A Facebook Page has to be connected before you can publish — posts go out with that Page\u2019s access token.',
  instagram:
    'An Instagram business account has to be connected before you can publish — posts go out through the Instagram Graph API.',
  youtube:
    'A YouTube channel has to be connected before you can publish — uploads go out through the YouTube Data API.',
  tiktok:
    'A TikTok account has to be connected before you can publish — direct posts go out through TikTok\u2019s Content Posting API.',
} as const;

export type GateHintPlatform = keyof typeof GATE_HINTS;
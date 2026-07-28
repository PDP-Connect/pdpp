// Typed fixture source. `tweet.js` is the generated legacy Twitter archive artifact.
export type LegacyTweetFixture = Record<string, unknown>;

export const legacyTweetFixture: LegacyTweetFixture[] = [
  {
    id_str: "9999",
    full_text: "Legacy flat shape (no .tweet wrapper)",
    created_at: "Wed Jun 06 10:00:00 +0000 2024",
    favorite_count: 3,
    retweet_count: 0,
    lang: "en",
    entities: { media: [], urls: [] },
  },
];

export function renderLegacyTweetFixture(): string {
  return `window.YTD.tweet.part0 = ${JSON.stringify(legacyTweetFixture, null, 2)};\n`;
}

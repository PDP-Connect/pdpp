// Typed fixture source. `tweets.js` is the generated empty Twitter archive artifact.
export const emptyTweetsFixture: readonly [] = [];

export function renderEmptyTweetsFixture(): string {
  return "window.YTD.tweets.part0 = [];\n";
}

/** Public immutable graphics, shared by every installation of this action. */
export const REVIEW_ASSET_REVISION = "be563a0141be67d40aec19516bee27619995d250";
const assets = `https://raw.githubusercontent.com/coryparrry/claude-code-action/${REVIEW_ASSET_REVISION}/assets/review`;

type Section = "walkthrough" | "changes" | "flow" | "scope";
type Risk = "low" | "moderate" | "high";
type Graphic = Section | "inspection" | `risk-${Risk}`;

/** Only fixed names and labels enter image markup; model output cannot supply URLs. */
function picture(name: Graphic): string {
  const badges = {
    inspection: { width: 124, label: "Code inspection" },
    "risk-low": { width: 58, label: "Low" },
    "risk-moderate": { width: 90, label: "Moderate" },
    "risk-high": { width: 64, label: "High" },
  };
  const badge = name in badges ? badges[name as keyof typeof badges] : null;
  const width = badge?.width ?? 20;
  const height = badge ? 22 : 20;
  const label = badge?.label ?? "";
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${assets}/${name}-dark.svg"><img src="${assets}/${name}-light.svg" alt="${label}" width="${width}" height="${height}" align="absmiddle"></picture>`;
}

export function renderReviewHeading(
  section: Exclude<Section, "scope">,
): string {
  const labels = {
    walkthrough: "Walkthrough",
    changes: "Changes",
    flow: "Flow diagram",
  };
  const badge =
    section === "walkthrough" ? ` &nbsp; ${picture("inspection")}` : "";
  return `<h3>${picture(section)} ${labels[section]}${badge}</h3>`;
}

/** The only rich disclosure labels are constructed from these fixed graphics. */
export function renderRiskDetails(level: Risk, body: string): string {
  return `<details>\n<summary><strong>Merge risk</strong> &nbsp; ${picture(`risk-${level}`)}</summary>\n\n${body.trim()}\n\n</details>`;
}

export function renderScopeDetails(body: string): string {
  return `<details>\n<summary>${picture("scope")} Review scope &amp; verification</summary>\n\n${body.trim()}\n\n</details>`;
}

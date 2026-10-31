/** Original, static review graphics. Regenerate with node scripts/generate-review-assets.mjs. */
import { mkdir, writeFile } from "node:fs/promises";

const directory = new URL("../assets/review/", import.meta.url);
await mkdir(directory, { recursive: true });
const themes = {
  light: {
    ink: "#59636e",
    background: "#f6f8fa",
    border: "#d1d9e0",
    blue: "#0969da",
    green: "#1a7f37",
    amber: "#9a6700",
    red: "#cf222e",
  },
  dark: {
    ink: "#9198a1",
    background: "#151b23",
    border: "#3d444d",
    blue: "#79c0ff",
    green: "#3fb950",
    amber: "#d29922",
    red: "#f85149",
  },
};
const icons = {
  walkthrough:
    '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v17H5.5A2.5 2.5 0 0 1 3 17.5zM11 3h7.5A2.5 2.5 0 0 1 21 5.5v12a2.5 2.5 0 0 0-2.5-2.5H11M3 17.5A2.5 2.5 0 0 1 5.5 15H11"/>',
  changes:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 15h8M12 11v8"/>',
  flow: '<rect x="2" y="3" width="7" height="5" rx="1"/><rect x="15" y="16" width="7" height="5" rx="1"/><path d="M5.5 8v7a3.5 3.5 0 0 0 3.5 3.5h6M12 15.5l3 3-3 3"/>',
  scope:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
function svg(width, height, label, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}"><title>${label}</title>${content}</svg>\n`;
}
for (const [theme, colors] of Object.entries(themes)) {
  for (const [name, drawing] of Object.entries(icons)) {
    await writeFile(
      new URL(`${name}-${theme}.svg`, directory),
      svg(
        24,
        24,
        name,
        `<g fill="none" stroke="${colors.ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${drawing}</g>`,
      ),
    );
  }
  const badges = [
    {
      name: "inspection",
      label: "Code inspection",
      width: 124,
      color: colors.blue,
      icon: `<g fill="none" stroke="${colors.blue}" stroke-width="1.4"><circle cx="13" cy="10" r="3.5"/><path d="m16 13 3 3"/></g>`,
    },
    ...[
      ["low", "Low", 58, colors.green, 1],
      ["moderate", "Moderate", 90, colors.amber, 2],
      ["high", "High", 64, colors.red, 3],
    ].map(([name, label, width, color, active]) => ({
      name: `risk-${name}`,
      label,
      width,
      color,
      icon: [0, 1, 2]
        .map(
          (index) =>
            `<rect x="${9 + index * 4}" y="${13 - index * 3}" width="2.5" height="${3 + index * 3}" rx=".75" fill="${index < active ? color : colors.border}"/>`,
        )
        .join(""),
    })),
  ];
  for (const badge of badges) {
    await writeFile(
      new URL(`${badge.name}-${theme}.svg`, directory),
      svg(
        badge.width,
        22,
        badge.label,
        `<rect x=".5" y=".5" width="${badge.width - 1}" height="21" rx="6" fill="${colors.background}" stroke="${colors.border}"/>${badge.icon}<text x="26" y="14.7" fill="${badge.color}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif" font-size="11" font-weight="600">${badge.label}</text>`,
      ),
    );
  }
}

// Original, deterministic vector sample artwork. Never used for a real recording.
const leaf = (x: number, y: number, angle: number, fill = "#788b60") =>
  `<ellipse cx="${x}" cy="${y}" rx="10" ry="25" fill="${fill}" transform="rotate(${angle} ${x} ${y})"/>`;
function plant(x: number, y: number, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M0 40Q-12-25 0-105M-4-30L-38-60M-2-65L27-92" fill="none" stroke="#5e7157" stroke-width="3"/>${leaf(-37, -64, -40)}${leaf(-15, -40, -35)}${leaf(22, -87, 40)}${leaf(0, -108, 8)}<path d="M-30 0H30L23 47H-23Z" fill="#ba7657"/><path d="M-34 0H34V9H-34" fill="#cd896b"/></g>`;
}
function child(x: number, y: number, scale = 1, arm = 0) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M-24 64L-26 130M22 64L24 130" stroke="#8d6952" stroke-width="19" stroke-linecap="round"/><path d="M-42 134Q-20 121-13 136M9 136Q18 123 36 134" fill="none" stroke="#534d40" stroke-width="14" stroke-linecap="round"/><path d="M-28-39Q-48-24-49 68Q0 88 49 68L35-31Q10-48-28-39Z" fill="#547d90"/><path d="M-5-35V72" stroke="#416777" stroke-width="3"/><path d="M-26-36L-10-13L0-29L12-12L30-36" fill="#cfdae0"/><path d="M-37-16Q-64 15 ${arm ? "-16 27" : "-35 43"}M34-14Q58 13 ${arm ? "13 25" : "34 44"}" fill="none" stroke="#547d90" stroke-width="18" stroke-linecap="round"/><circle cx="${arm ? -16 : -35}" cy="${arm ? 27 : 45}" r="9" fill="#d6a483"/><circle cx="${arm ? 13 : 34}" cy="${arm ? 25 : 45}" r="9" fill="#d6a483"/><circle cy="-67" r="36" fill="#58463b"/><ellipse cy="-62" rx="27" ry="32" fill="#dfb18e"/><path d="M-32-67Q-39-106 1-105Q39-101 30-67L13-88Q-4-63-32-67" fill="#58463b"/><circle cx="-10" cy="-61" r="2.2" fill="#493e36"/><circle cx="11" cy="-61" r="2.2" fill="#493e36"/><path d="M-5-48Q1-43 7-48" fill="none" stroke="#995f4c" stroke-width="2" stroke-linecap="round"/>${[0, 25, 50].map((y) => `<circle cx="1" cy="${y}" r="6" fill="#d0ab66"/><circle cx="0" cy="${y - 1}" r="1" fill="#756247"/><circle cx="3" cy="${y + 1}" r="1" fill="#756247"/>`).join("")}</g>`;
}
function aunt(x: number, y: number, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M-20 79L-28 137M24 79L38 137" stroke="#806044" stroke-width="19" stroke-linecap="round"/><path d="M-35-37Q-55 24-68 93Q0 113 69 93L35-34Z" fill="#ab7158"/><path d="M-38-18Q-56 23-13 43M37-16Q62 20 29 46" fill="none" stroke="#b47d61" stroke-width="21" stroke-linecap="round"/><circle cx="-13" cy="43" r="10" fill="#d2a583"/><circle cx="29" cy="46" r="10" fill="#d2a583"/><circle cx="15" cy="-108" r="22" fill="#514a3a"/><ellipse cy="-76" rx="33" ry="40" fill="#514a3a"/><ellipse cy="-66" rx="27" ry="33" fill="#d7af8e"/><path d="M-31-74Q-27-116 10-106L31-77Q9-75-1-96Q-8-79-31-74" fill="#514a3a"/><circle cx="-10" cy="-66" r="2" fill="#493e36"/><circle cx="10" cy="-66" r="2" fill="#493e36"/><path d="M-7-51Q0-45 8-52" stroke="#925b48" stroke-width="2" fill="none"/><path d="M-48 140H-13M26 140H57" stroke="#534d40" stroke-width="12" stroke-linecap="round"/></g>`;
}
function button(x: number, y: number, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><circle r="48" fill="#c09a53"/><circle r="37" fill="#d6b772" stroke="#b99550" stroke-width="2"/>${[-10, 10].flatMap((x) => [-10, 10].map((y) => `<circle cx="${x}" cy="${y}" r="5" fill="#87734c"/>`)).join("")}<path d="M-10-10L10 10M10-10L-10 10" stroke="#ede1bc" stroke-width="4"/></g>`;
}
export function artSvg(scene = 0): string {
  let drawing: string;
  const room = `<path d="M0 0H600V600H0Z" fill="#e5deca"/><path d="M64 54H337V457H64Z" fill="#b5b99b"/><path d="M77 68H324V457H77Z" fill="#788879"/><path d="M96 83H305V444H96Z" fill="#929e87"/><path d="M206 92V441M103 264H299" stroke="#748474" stroke-width="8"/><circle cx="285" cy="283" r="6" fill="#c6ad72"/><path d="M0 446H600V600H0Z" fill="#c8ba9e"/><path d="M22 443H489V470H22ZM10 470H516V502H10Z" fill="#9b8466"/><path d="M10 484H516" stroke="#897359" stroke-width="2"/>`;
  if ([0, 1, 2, 3, 7, 9].includes(scene)) {
    drawing = room + plant(523, 424, 1.1);
    const arrangements: Record<number, string> = {
      0: aunt(344, 319, 0.9) + child(211, 361, 0.85),
      1: aunt(337, 316, 1) + child(192, 355, 0.87),
      2: aunt(353, 314, 0.85) + child(207, 365, 1.02, 1),
      3: aunt(303, 314, 1.05) + child(168, 369, 0.86, 1),
      7: aunt(376, 315, 0.87) + child(230, 355, 1.02, 1),
      9: aunt(346, 315, 1.02) + child(200, 352, 0.95),
    };
    drawing += arrangements[scene];
  } else if ([4, 5, 6, 8].includes(scene)) {
    drawing = `<rect width="600" height="600" fill="#d9dece"/><path d="M104 52Q300 0 496 52L560 600H40Z" fill="#648a9a"/><path d="M282 62V600" stroke="#436f83" stroke-width="6"/><path d="M122 40L211 146L287 60L365 145L472 39" fill="#d5dfe0"/>`;
    if (scene === 4)
      drawing += `<path d="M49 469Q55 322 155 293L268 250Q303 251 284 280L208 318Q245 357 191 381L112 430Z" fill="#d6a483"/><path d="M556 489Q546 307 431 305L329 279Q303 285 321 310L395 344Q361 373 414 402L501 455Z" fill="#dfb18e"/><g transform="translate(300 277) rotate(-30) scale(.3 1)">${button(0, 0, 1)}</g>`;
    else
      drawing +=
        [200, 330, 460]
          .map((y, i) => button(300, y, scene === 5 && i > 0 ? 0.65 : 0.7))
          .join("") +
        (scene === 8
          ? ""
          : `<path d="M39 464Q58 358 153 341L246 301Q278 308 254 331L194 365Q226 400 171 417L77 476Z" fill="#dfb18e"/>`);
    drawing += leaf(72, 90, -45, "#b7c1a3") + leaf(526, 535, 30, "#b7c1a3");
  } else if (scene === 10) {
    drawing = `<rect width="600" height="600" fill="#d8dfcf"/><circle cx="457" cy="105" r="48" fill="#eee1b1"/><path d="M0 346Q151 244 312 337T600 319V600H0Z" fill="#a7b499"/><path d="M0 421Q114 359 313 426T600 402V600H0Z" fill="#879c79"/><path d="M299 346Q137 481 206 600H447Q282 464 353 349Z" fill="#d4c6a7"/>${plant(79, 433, 1.3)}${plant(527, 482, 0.8)}${aunt(359, 284, 1)}${child(230, 373, 0.78)}${leaf(84, 143, 37)}${leaf(533, 278, -30)}`;
  } else {
    drawing = `<rect width="600" height="600" fill="#e4d9bd"/><path d="M80 58H520V548H80Z" fill="#c7bd9f"/><path d="M94 72H506V534H94Z" fill="#f0e7d0"/><path d="M301 125V161M301 160L191 217H411Z" fill="none" stroke="#9a835e" stroke-width="6" stroke-linecap="round"/><path d="M207 198L276 192L300 213L325 192L395 198L442 295L390 316L375 463Q301 486 220 463L209 316L157 295Z" fill="#547d90"/><path d="M300 216V476" stroke="#416777" stroke-width="4"/>${[273, 338, 403].map((y) => button(301, y, 0.27)).join("")}${plant(65, 484, 0.7)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><filter id="paper"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".09"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter></defs><g>${drawing}</g><rect width="600" height="600" fill="#e8dfcc" opacity=".18" filter="url(#paper)"/></svg>`;
}
export function artDataUrl(scene: number) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSvg(scene))}`;
}

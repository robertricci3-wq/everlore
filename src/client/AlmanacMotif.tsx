/** Original code-drawn chapter ornaments; not character canon or book artwork. */
export function AlmanacMotif({ index = 0 }: { index?: number }) {
  const color = [
    "#587568",
    "#a77151",
    "#6b817c",
    "#b48c52",
    "#638179",
    "#a27662",
    "#8e795a",
    "#829075",
  ][index % 8];
  return (
    <svg viewBox="0 0 280 140" aria-hidden="true" className="almanac-motif">
      <ellipse cx="140" cy="122" rx="78" ry="7" fill={color} opacity=".12" />
      <g
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {index % 8 === 0 ? (
          <>
            <path d="M137 27l32 28-26 35-32-28z" fill={color} opacity=".2" />
            <path d="M137 27l6 63m-32-28 58-7m-26 35c-18 16 12 13-4 27-8 7-13 1-21 8M123 44l29 24m-23 31-11 1 6 8" />
            <path d="M86 64l4-8m-17 32 11-2m95-48 4-9" />
          </>
        ) : index % 8 === 1 ? (
          <>
            <path d="M94 116V56l30-18 29 18v60M104 113V68h25v45M129 70l5 2m36 42V40l22-11v88" />
            <path d="M81 117h128M95 57h59M159 81c11 3 18 0 20-10m-36 20 27-6" />
            <path
              d="M201 52c10-15 17-7 9 1-9 8-10 9-10 9s-6-12-9-17c-3-10 8-12 10 7"
              fill={color}
              opacity=".25"
            />
          </>
        ) : index % 8 === 2 ? (
          <>
            <path d="M83 80l58-43 58 43M95 78v39h89V78M131 117V86h24v31M108 79h12v13h-12zM163 79h12v13h-12zM88 119h107" />
            <path
              d="M202 118V91m0 16c-20-3-12-20 0-16 12-17 26-4 12 9l-12 7"
              fill={color}
              opacity=".2"
            />
            <path d="M166 37V24h12v22" />
          </>
        ) : index % 8 === 3 ? (
          <>
            <path
              d="M102 110c-11-15-14-24-15-40h74c-1 19-8 34-18 40z"
              fill={color}
              opacity=".2"
            />
            <path d="M88 70h73c26-1 27 26-7 28M92 113h63M182 113V60m0 4c-21 0-11-32 0-32s21 32 0 32M110 53c-8-11 9-16 3-26M134 53c-7-12 10-16 4-28" />
          </>
        ) : index % 8 === 4 ? (
          <>
            <path
              d="M76 112l45-68 25 40 18-26 44 54z"
              fill={color}
              opacity=".18"
            />
            <path d="M76 112l45-68 25 40m-39-18 14 5 10-7M136 108l28-50 44 54M165 116c-22 0-56 13-44 16" />
            <circle cx="186" cy="34" r="12" fill={color} opacity=".25" />
          </>
        ) : index % 8 === 5 ? (
          <>
            <path
              d="M105 110l55-70 10 8-55 70-14 4z"
              fill={color}
              opacity=".2"
            />
            <path d="M101 122l4-12 10 8m45-78 7-9c7-7 15 4 9 11l-6 6M94 40h27v56H94zM101 51h8m-8 13h13m-13 13h8M141 114c8-7 6-17 18-11 14 8-6 21 11 19h25" />
          </>
        ) : index % 8 === 6 ? (
          <>
            <path d="M135 38v66c-16 17-25 7-13-4 4-4 9-5 13-5M135 39l38-11v64c-17 17-28 5-13-6 4-3 8-3 13-3M136 49l36-10M95 70l14 2m-19 16 15-2M186 106l11 6" />
            <path
              d="M72 112c8-8 12-10 18-4s10 10 17 3M183 57c21 4 23 21 4 27"
              fill={color}
              opacity=".2"
            />
          </>
        ) : (
          <>
            <path
              d="M140 120V67m0 27c-30-3-41-29-17-26 9 1 16 13 17 26m0-12c34-3 38-32 19-25-12 4-19 18-19 25M118 123h45"
              fill={color}
              opacity=".2"
            />
            <path d="M130 54c-1-19 15-18 14-4 8-12 22-2 10 9-9 8-16 10-16 10s-4-8-8-15" />
            <path d="M92 53l6-7m84 50 8-1m-4-55 4-8" />
          </>
        )}
      </g>
    </svg>
  );
}

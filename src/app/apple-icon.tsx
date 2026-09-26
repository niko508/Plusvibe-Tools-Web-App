import { ImageResponse } from "next/og";

// Apple touch / home-screen bookmark icon (180×180 PNG), generated so we don't
// have to ship a binary asset. Mirrors the red brand tile in src/app/icon.svg.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f43f5e, #e11d48)",
        }}
      >
        <svg width="118" height="118" viewBox="0 0 32 32" fill="none">
          <path
            d="M6 20l6.5-12 5.5 9.5 2.5-4L27 21"
            stroke="#fff"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size }
  );
}

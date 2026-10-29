import type { NextConfig } from "next";

// An isolated app importing production components. No production routes,
// authentication bypass, or fixture endpoints are added to the real app.
const config: NextConfig = { devIndicators: false };
export default config;

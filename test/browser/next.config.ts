import type { NextConfig } from "next";

// An isolated app importing production components. No production routes,
// authentication bypass, or fixture endpoints are added to the real app.
const config: NextConfig = { devIndicators: false, allowedDevOrigins: ["127.0.0.1", "localhost"] };
export default config;

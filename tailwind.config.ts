import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        muted: "#667085",
        line: "#e4e7ec",
        panel: "#ffffff",
        soft: "#f7f8fa",
        buy: "#057a55",
        sell: "#b42318",
        accent: "#155eef"
      },
      boxShadow: {
        panel: "0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.08)"
      }
    }
  },
  plugins: []
};

export default config;

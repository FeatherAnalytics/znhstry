import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    rules: {
      // React 19 compiler rules — the codebase predates the compiler and uses
      // ref patterns, conditional hooks, setState-in-effect, and mutable-local
      // patterns the compiler rejects. Re-enable when adopting the compiler.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/variables": "off",
      "react-hooks/immutability": "off",
    },
  },
];

export default config;

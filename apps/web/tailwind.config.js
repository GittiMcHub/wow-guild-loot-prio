/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // WoW class colors, defined once (§11).
        class: {
          warrior: '#C79C6E',
          paladin: '#F58CBA',
          hunter: '#ABD473',
          rogue: '#FFF569',
          priest: '#FFFFFF',
          shaman: '#0070DE',
          mage: '#69CCF0',
          warlock: '#9482C9',
          druid: '#FF7D0A',
        },
      },
    },
  },
  plugins: [],
};

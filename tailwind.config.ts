/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Core UI colors – pure white background and a dark foreground for readable text.
        background: "#FFFFFF",   // Use the base white background as required.
        foreground: "#111111",   // Dark text color for primary content.
      },
    },
  },
  plugins: [],
}
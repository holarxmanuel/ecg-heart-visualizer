/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        // Dark clinical palette, modelled on real bedside monitors.
        ink: {
          900: '#07090d',
          800: '#0b0f16',
          700: '#111725',
          600: '#18202f',
          500: '#222c3d',
        },
        trace: {
          ecg: '#31e07a', // the classic monitor green
          raw: '#3f5f7a', // dim blue-grey for the unfiltered trace
          alert: '#ff4d5e',
          amber: '#ffb020',
        },
        cardiac: '#e8384f',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
        display: ['"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

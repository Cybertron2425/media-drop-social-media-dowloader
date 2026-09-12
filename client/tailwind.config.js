/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0d1210',
          900: '#121815',
          800: '#1b2320',
          700: '#28322e',
          600: '#3a4844',
        },
        paper: {
          50: '#f7f8f3',
          100: '#eef0e7',
        },
        signal: {
          DEFAULT: '#5ee6a8',
          dim: '#3aa87d',
        },
      },
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

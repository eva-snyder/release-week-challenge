# Top Listeners (web + backend)

## Run locally

**Terminal 1 — backend**

```bash
cd ../backend
cp .env.example .env   # once; fill Last.fm API key + secret
npm install
npm run dev
```

**Terminal 2 — web**

```bash
npm install
npm run dev
```

### Important: use `127.0.0.1`, not `localhost`

Last.fm sends users back to `http://127.0.0.1:8787/auth/callback` (register that URL on your Last.fm API app). Browsers treat `localhost` and `127.0.0.1` as **different hosts** for cookies.

1. Set `FRONTEND_ORIGIN` in `backend/.env` to the exact Vite URL but with **127.0.0.1** (e.g. `http://127.0.0.1:5174` if that’s the port Vite prints).
2. Open the app in the browser at that **same** URL (not `http://localhost:...`).

Then **sign in with Last.fm** should complete without “State mismatch”, and your session cookie will work for `/api/...` through the Vite proxy.

## Last.fm app settings

- Callback URL: `http://127.0.0.1:8787/auth/callback` (see [Last.fm API authentication](https://www.last.fm/api/authentication))

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

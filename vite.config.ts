import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { resolve } from "node:path";
import AutoImport from "unplugin-auto-import/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  define: {
    __BASE_PATH__: JSON.stringify("/"),
    __IS_PREVIEW__: JSON.stringify(false),
    __READDY_PROJECT_ID__: JSON.stringify(process.env.PROJECT_ID || ""),
    __READDY_VERSION_ID__: JSON.stringify(process.env.VERSION_ID || ""),
    __READDY_AI_DOMAIN__: JSON.stringify(process.env.READDY_AI_DOMAIN || ""),
  },
  plugins: [
    react(),
    AutoImport({
      imports: [
        { react: ["React", "useState", "useEffect", "useContext", "useReducer", "useCallback", "useMemo", "useRef", "useImperativeHandle", "useLayoutEffect", "useDebugValue", "useDeferredValue", "useId", "useInsertionEffect", "useSyncExternalStore", "useTransition", "startTransition", "lazy", "memo", "forwardRef", "createContext", "createElement", "cloneElement", "isValidElement"] },
        { "react-router-dom": ["useNavigate", "useLocation", "useParams", "useSearchParams", "Link", "NavLink", "Navigate", "Outlet"] },
        { "react-i18next": ["useTranslation", "Trans"] },
      ],
      dts: true,
    }),
    nodePolyfills({ buffer: true }),
  ],
  base: "/", 
  build: {
    sourcemap: true,
    outDir: "dist",        // ← make sure it's "dist"
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
  },
});

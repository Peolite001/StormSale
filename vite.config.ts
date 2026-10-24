import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import crypto from "node:crypto";

/**
 * Options for Subresource Integrity (SRI) plugin.
 */
export interface SubresourceIntegrityOptions {
  /**
   * Cryptographic hash algorithm(s) to use.
   * Default: ['sha384'] (W3C standard recommendation for Subresource Integrity)
   */
  algorithms?: ("sha256" | "sha384" | "sha512")[];
  /**
   * Crossorigin attribute to inject for SRI-enabled assets.
   * Default: 'anonymous'
   */
  crossorigin?: "anonymous" | "use-credentials";
  /**
   * Integrity hashes for external (absolute or protocol-relative) URLs such as
   * third-party CDN scripts. Keys are exact URLs found in the HTML `src`/`href`
   * attribute; values are pre-computed integrity strings (e.g. `sha384-…`).
   *
   * Any external URL not present in this map is left untouched, so the caller
   * stays in control of which third-party resources are pinned.
   */
  external?: Record<string, string>;
}

/**
 * Well-known integrity hashes for third-party assets loaded from StormSale's
 * `index.html`. Keep this map small and reviewed — values must be produced from
 * the upstream file (e.g. `openssl dgst -sha384 -binary file.js | base64 -w0`)
 * so the browser can verify them at load-time.
 */
export const KNOWN_EXTERNAL_INTEGRITY: Record<string, string> = {
  // Telegram Mini Apps SDK – https://telegram.org/js/telegram-web-app.js
  "https://telegram.org/js/telegram-web-app.js":
    "sha384-PyI6uk8O3pfRRl4+CaepaS++FqtEbco/HaV3jzdYl4y+U7HMQvn3gWVfKhjuzfzG",
};

/**
 * Computes the Subresource Integrity hash for a given content string or buffer.
 */
export function computeIntegrity(
  content: string | Uint8Array,
  algorithms: readonly ("sha256" | "sha384" | "sha512")[] = ["sha384"],
): string {
  return algorithms
    .map((algo) => {
      const hash = crypto.createHash(algo).update(content).digest("base64");
      return `${algo}-${hash}`;
    })
    .join(" ");
}

/**
 * Vite plugin for automatic build-time Subresource Integrity (SRI) hash injection.
 * Injects cryptographic hashes and crossorigin attributes into HTML asset tags (<script>, <link>)
 * and output bundle entries to prevent resource tampering on script and asset load.
 */
export function subresourceIntegrity(options?: SubresourceIntegrityOptions): Plugin {
  const algorithms = options?.algorithms ?? ["sha384"];
  const crossOrigin = options?.crossorigin ?? "anonymous";
  const externalMap: Record<string, string> = { ...KNOWN_EXTERNAL_INTEGRITY, ...(options?.external ?? {}) };
  const EXTERNAL_URL_RE = /^(https?:)?\/\//i;
  let base = "/";

  /**
   * Given a `src`/`href` value, return the integrity string to inject or
   * `undefined` when the tag should be left untouched.
   */
  const resolveIntegrity = (url: string, bundle: OutputBundle): string | undefined => {
    if (EXTERNAL_URL_RE.test(url)) {
      // Pin only explicitly allow-listed third-party URLs.
      return externalMap[url];
    }

    const cleanUrl = url.split(/[?#]/)[0];
    let normalized = cleanUrl;
    if (base !== "/" && normalized.startsWith(base)) {
      normalized = normalized.slice(base.length);
    }
    normalized = normalized.replace(/^\.?\//, "");

    const item: OutputAsset | OutputChunk | undefined =
      bundle[normalized] ?? Object.values(bundle).find((i) => i.fileName === normalized);
    if (!item) return undefined;

    const content = item.type === "chunk" ? item.code : item.source;
    if (!content) return undefined;
    return computeIntegrity(content as string | Uint8Array, algorithms);
  };

  const applyIntegrityAttrs = (attrs: string, integrity: string) => {
    const isSelfClosing = /\/\s*$/.test(attrs);
    let cleaned = attrs.replace(/\/\s*$/, "").trim();
    if (!/(?:^|\s)integrity(?=[\s=>]|$)/i.test(cleaned)) {
      cleaned += ` integrity="${integrity}"`;
    }
    if (!/(?:^|\s)crossorigin(?=[\s=>]|$)/i.test(cleaned)) {
      cleaned += ` crossorigin="${crossOrigin}"`;
    }
    return { cleaned, isSelfClosing };
  };

  return {
    name: "vite-plugin-subresource-integrity",
    enforce: "post",
    apply: "build",

    configResolved(config) {
      base = config.base || "/";
    },

    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) {
          return html;
        }

        const bundle = ctx.bundle;

        // 1. Process <script ...> tags (both first-party bundle and pinned external URLs)
        html = html.replace(/<script\b([^>]*)>/gi, (fullMatch, attrs: string) => {
          const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
          if (!srcMatch) return fullMatch;
          const integrity = resolveIntegrity(srcMatch[1], bundle);
          if (!integrity) return fullMatch;
          const { cleaned, isSelfClosing } = applyIntegrityAttrs(attrs, integrity);
          return `<script ${cleaned}${isSelfClosing ? " />" : ">"}`;
        });

        // 2. Process <link ...> tags (stylesheets, modulepreload, preload)
        html = html.replace(/<link\b([^>]*)>/gi, (fullMatch, attrs: string) => {
          const relMatch = attrs.match(/\brel=["']([^"']+)["']/i);
          const rel = relMatch ? relMatch[1].toLowerCase() : "";
          if (!["stylesheet", "modulepreload", "preload"].includes(rel)) {
            return fullMatch;
          }
          const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
          if (!hrefMatch) return fullMatch;
          const integrity = resolveIntegrity(hrefMatch[1], bundle);
          if (!integrity) return fullMatch;
          const { cleaned, isSelfClosing } = applyIntegrityAttrs(attrs, integrity);
          return `<link ${cleaned}${isSelfClosing ? " />" : ">"}`;
        });

        return html;
      },
    },

    generateBundle(_outputOptions, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        const content = item.type === "chunk" ? item.code : item.source;
        if (content) {
          const hash = computeIntegrity(content, algorithms);
          (item as unknown as { integrity?: string }).integrity = hash;
        }

        if (fileName.endsWith("manifest.json") && item.type === "asset") {
          try {
            const manifest = JSON.parse(item.source.toString());
            for (const entry of Object.values<Record<string, unknown>>(manifest)) {
              if (typeof entry.file === "string" && bundle[entry.file]) {
                const target = bundle[entry.file];
                const targetContent = target.type === "chunk" ? target.code : target.source;
                if (targetContent) {
                  entry.integrity = computeIntegrity(targetContent, algorithms);
                }
              }
              if (Array.isArray(entry.css)) {
                entry.cssIntegrity = entry.css.map((cssFile: string) => {
                  const cssTarget = bundle[cssFile];
                  if (cssTarget && cssTarget.type === "asset") {
                    return computeIntegrity(cssTarget.source, algorithms);
                  }
                  return null;
                });
              }
            }
            item.source = JSON.stringify(manifest, null, 2);
          } catch {
            // Silently fallback if manifest parsing fails
          }
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    subresourceIntegrity(),
    visualizer({ open: false, gzipSize: true, brotliSize: true }),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    preserveSymlinks: true,
  },
  build: {
    rollupOptions: {
      external: ["@ledgerhq/hw-transport-webhid", "@ledgerhq/hw-app-str"],
      output: {
        manualChunks: (id) => {
          if (id.includes("@stellar/stellar-sdk") || id.includes("@stellar/freighter-api")) {
            return "vendor-stellar-sdk";
          }
          if (id.includes("framer-motion")) {
            return "vendor-framer-motion";
          }
          if (id.includes("@radix-ui/")) {
            return "vendor-radix-ui";
          }
        },
      },
    },
  },
  test: {
    globals: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/tests/**",
        "src/types/**",
        "src/main.tsx",
        "src/assets/**",
      ],
    },
  },
});

# Visual answers: prior art, what to reuse, and what Myrmidon builds

Research and build notes, 2026-10-16, branch `visual-answers`. The ask: "omp's latest updates also show UIs like
ChatGPT that help the user visualise things better." This note covers what omp 18.11.1 draws, how ChatGPT, Claude,
Gemini and MCP Apps do rich answers, which open-source pieces fit Myrmidon, and the design built on this branch.

**V** = verified: read in source (path given) or on a primary page (official docs, repository, npm registry).
**I** = inferred: a secondary source or my own reasoning. Quotes are kept under 15 words.

## 1. omp 18.11.1 (read in `node_modules/.bun/@oh-my-pi+pi-coding-agent@18.11.1…` and `@oh-my-pi+pi-tui@18.11.1`)

- **SVG figures.** 18.7.0 added inline rendering of agent-written SVG "diagrams, charts, and mockups" with
  theme-aware colours, behind `tui.renderSvg` (V, `pi-coding-agent/CHANGELOG.md` 18.7.0). The renderer is
  `pi-tui/src/chat/svg-figure.ts` (401 lines) with `svg-source.ts`; it rasterises for the terminal's image protocol and
  redraws while the fence streams (V, `chat/fence-figure.ts`).
- **Mermaid.** ` ```mermaid ` fences draw as ASCII art once the fence closes (V, `chat/fence-figure.ts`, header
  comment). 18.10.x fixed HTML entities in labels and a frozen `xychart` (V, CHANGELOG).
- **Auto charts from tables.** `tui.autoGraph` (`always`, `smart`, `off`) charts numeric Markdown tables under the
  table (V, CHANGELOG 18.7.0, 18.9.0). The planner is large and fitted on ~7k real answers: bar, paired, grouped,
  stacked, line and more, label/measure detection, totals kept out of scale (V, `pi-tui/src/charts/chart-plan.ts`,
  5,081 lines; `chart-svg.ts` 4,657; `table-data.ts` 1,478).
- **Eval `display()`.** A structured `display()` value shows once, as a JSON tree, while the model still reads the
  text (V, CHANGELOG 18.11.1, #12730). The JS worker sends `{ type: "json" | image | status }` display outputs
  (V, `src/eval/js/shared/types.ts:17`); Python bundles add `application/x-omp-image`, `image/png`, markdown and status
  (V, `src/eval/py/display.ts`).
- **`read.renderMarkdown`** renders Markdown files formatted in read previews (V, CHANGELOG 18.10.3, #15007). Write
  previews draw SVG files as images and `.mmd` files as diagrams (V, CHANGELOG 18.8.0).
- **The prompt.** omp's system prompt, when any of these is on, says: first fit wins, one form per idea, never the same
  content twice; Mermaid only for genuine structure; an SVG is not to be announced or restated; SVG colours only through
  `currentColor` and `var(--fg)`, `--muted`, …, `--c1…--c6`; static, no scripts or `<foreignObject>`
  (V, `src/prompts/system/system-prompt.md:12-25`).

## 2. Products

- **ChatGPT.** Interactive charts cover bar, line, pie and scatter; other types come back as static images with a
  toggle (I: help.openai.com refused the fetch; text from search results quoting
  [OpenAI help 8437071](https://help.openai.com/en/articles/8437071) and
  [the data-analysis post](https://openai.com/index/improvements-to-data-analysis-in-chatgpt)). Apps SDK widgets run
  in an iframe on JSON-RPC over postMessage, MIME `text/html;profile=mcp-app`, with CSP allowlists `connectDomains`,
  `resourceDomains`, `frameDomains`; `window.openai` is a ChatGPT layer on MCP Apps
  (V, [developers.openai.com/apps-sdk/build/custom-ux](https://developers.openai.com/apps-sdk/build/custom-ux)).
- **Claude.** Inline visuals in chat (beta 2026-03-12, all plans) are temporary and separate from Artifacts, which
  persist in a side panel (V, [claude.com/blog/claude-builds-visuals](https://claude.com/blog/claude-builds-visuals)).
  That page does not say how they are built; HTML/SVG is a third party's claim (I). Artifacts run in sandboxed iframes
  with strict CSP and full-site process isolation (I, interview summary,
  [simonwillison.net 2024-08-28](https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts)). A meta CSP in
  a `sandbox="allow-scripts"` frame cannot be lifted by the frame's own script (I, third-party test,
  [simonwillison.net 2026-04-03](https://simonwillison.net/2026/Apr/3/test-csp-iframe-escape/)).
- **Gemini.** Dynamic view / generative UI (Nov 2025, Gemini 3) designs and codes a custom interactive response per
  prompt (V, [research.google generative UI](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/));
  Canvas turns prompts into apps, games, infographics and Deep Research into pages and quizzes
  (V, [gemini.google/overview/canvas](https://gemini.google/overview/canvas/)).
- **MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`).** Draft since 2025-11-21. `ui://` resources of MIME
  `text/html;profile=mcp-app`; web hosts use a double iframe (an outer proxy on another origin), desktop hosts may use
  one. Default view CSP: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'none'`. Messages `ui/initialize`, `ui/notifications/size-changed`, `ui/message`,
  `ui/open-link`, `tools/call`, `host-context-changed` (theme variables in `HostContext.styles.variables`)
  (V, [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) spec draft). `@mcp-ui/*` now
  implements it (V, [mcpui.dev](https://mcpui.dev/guide/introduction)).

What they share: the model writes a **declarative spec or a self-contained page**, the host draws it, and anything
that runs code is **isolated by origin and CSP** with **no network by default**; the text answer stands on its own.

## 3. Open-source pieces, judged

Versions, licences and dates from `registry.npmjs.org` (V); sizes are bundlephobia min+gzip (V) unless noted.

| Piece | Licence · version | Size (gz) | Maintained | Fit (React 19, Tailwind tokens) | Safety | Verdict |
|---|---|---|---|---|---|---|
| **Mermaid** | MIT · 11.17.2 (2025-08-25); 12.2.0 latest | ~174 KB core, diagrams lazy | very active | renders SVG; themed by `themeVariables` | `securityLevel: 'strict'` encodes labels, no clicks (V, mermaid.js.org) | **Adopt 11.17.2**: v12 targets Safari 17.4+/ES2024 (V, release notes) and our WKWebView floor is unpinned (I) |
| **Vega-Lite + Vega** | BSD-3 · vega-lite 6.4.3, vega 6.4.0 | 90 + 182 KB | active | declarative JSON models know well; themed by `config` | uses `Function` unless **vega-interpreter** (3 KB) evaluates expressions (V, vega.github.io/vega/usage/interpreter); a custom loader refuses loads (V, vega-loader README) | **Adopt** (without vega-embed: we keep our own toolbar) |
| vega-embed | BSD-3 · 7.3.0 | 21 KB | active | adds menus we replace | `actions:false` needed | Skip |
| Recharts / shadcn chart | MIT · 3.10.1 | 152 KB | active | best token fit (`var(--chart-N)`) | JSX, not a spec a model sends | Skip: needs a spec of our own to map; Vega-Lite is already a spec |
| streamdown | Apache-2.0 · 2.7.0 | 154 KB + plugins | active (Vercel) | React 19, Tailwind v4, streams half-written Markdown | `rehype-harden` | Not now: replaces `Markdown.tsx` and its injection/linear-time tests; revisit as its own change |
| react-markdown + remark-gfm | MIT · 10.1.0 + 4.0.1 | 34 + 10 KB | stable | | needs rehype-sanitize | Skip (same reason) |
| TanStack Table | MIT · 9.3.1 | 32 KB | active | headless, token-styled | — | Not needed yet: sort + filter is ~150 lines here; take it when tables need paging, pinning or grouping |
| react-json-view-lite | MIT · 2.5.0 | 2 KB | 2025-09 | own CSS classes | — | Skip: a token-styled tree is ~80 lines |
| DOMPurify | MPL-2.0 OR Apache-2.0 · 3.4.17 | 11 KB | active | — | the standard sanitiser | Not added: SVG is drawn as an `<img>`, where nothing runs or loads; a small allow-nothing pass cleans the copy |
| assistant-ui | MIT · 0.15.29 | n/m | very active | a whole chat framework | — | Skip: overlaps our chat; take patterns only |
| AI SDK generative UI / AI Elements | Apache-2.0 | `ai` 123 KB | AI Elements deprecated end Nov 2026 (V, repo) | tool-part rendering | — | Skip |
| CopilotKit | MIT · 1.79.1 | n/m | active | framework | — | Skip |
| `@modelcontextprotocol/ext-apps` | MIT · 2.0.3 | 10 KB | active | protocol types | — | Not yet: borrow its CSP and sandbox; adopt when MCP servers' UIs are shown |
| LibreChat | MIT | — | active | Sandpack for HTML/React artifacts | Sandpack uses CodeSandbox's CDN unless self-hosted (V, librechat.ai docs) | Not local-first; skip |
| Open WebUI | custom "Open WebUI License" | — | active | srcdoc iframe artifacts | scripts on, same-origin off, `IFRAME_CSP` empty by default (V, docs.openwebui.com) | Licence and empty CSP: skip |
| LobeChat | LobeHub Community License (not OSI) | — | active | — | — | Do not copy code |
| Chainlit | Apache-2.0 | — | active | custom JSX elements, no sandbox mentioned (V) | runs in-app | Skip |

**Recommendation, as built:** adopt Mermaid and Vega-Lite (with Vega and vega-interpreter), the two places where
building is unrealistic and a well-known spec matters most, since models already write both fluently. Build the small,
token-styled parts (frame, sortable table, JSON tree, SVG figure, widget frame) where a dependency would cost more
theming than it saves. Follow MCP Apps' CSP and sandbox for widgets so a later MCP-UI host can share the frame.

## 4. What Myrmidon draws

An agent writes a fenced block in its reply; the chat draws it once the fence closes (a placeholder while it streams):

| Fence | Spec (checked in `apps/web/src/client/chat/visuals/spec.ts`) | Drawn with | Download |
|---|---|---|---|
| ` ```chart ` | Vega-Lite JSON; data inline (`values`); any `url` or `href` refused; ≤ `CHART_MAX_ROWS` rows | Vega (SVG renderer), app theme as `config` | PNG |
| ` ```mermaid ` | Mermaid source; `%%{init}%%` dropped so the app's theme holds | Mermaid strict, SVG text labels, shown as `<img>` | SVG |
| ` ```table ` | `{columns, rows, caption?}`, rows of records, or rows under a header | `DataTable`: sort by header, filter from 8 rows | CSV |
| ` ```json-tree ` | any JSON | `JsonTree`: folds, opens two levels | JSON |
| ` ```svg ` | an `<svg>`; scripts, events, `foreignObject`, motion, outside links removed | `<img>` with `var(--…)`/`currentColor` made concrete | SVG |
| ` ```widget ` | one HTML page | sandboxed iframe (below) | HTML |
| `![alt](data:image/…)` | png, jpeg, gif or webp inline | `<img>`; remote pictures are never fetched | file |

Plain Markdown tables also sort and filter. A spec that fails its check, or a renderer that throws, shows the fence as
code under one line saying why: the text never goes. Each frame has Source (show, copy) and Download.

**Code cells.** The eval tool keeps what `display()` showed on its `tool/result` (`displays`: JSON cut to
`CELL_DISPLAY_JSON_CHARS`, pictures stored as blobs, Altair's Vega-Lite and SVG bundles too); the chat shows a step
"Ran a Python cell that showed N results" drawn with the same components: records as a table, other JSON as a tree.

**Text fallback.** `visualFallback` (`packages/protocol/src/visuals.ts`) puts each non-Mermaid visual as one line
(`[Chart: Visitors by park, in the Myrmidon app]`) for channel messages (`channels/hub.ts`), reading aloud and copying
(`plainText`). Mermaid source is sent as is: it reads as steps.

**Prompt.** One line for every speaker under "Talking to the person" (after omp's rules above and Claude Code's
data-visualization "is it even a chart?" guidance: only where a picture says more than prose, one per idea, never decoration, the point in a sentence, `prompt-library/claude-code/raw/system-prompts/data-data-
visualization-choosing-a-form.md`), the formats in `reply_user`'s `text` parameter where the reply is written, and the
eval tool saying the person sees each `display()` drawn. Word budgets were raised by the line's ~60 words.

**Theme, width, motion.** Colours come from the app's tokens, read again on theme change; six chart series tokens
(`--series-1…6`) were added in both themes from the dataviz reference palette and pass its validator on our surfaces
(light `#ffffff`: all checks pass, contrast warns for 3 slots so legends and labels stay; dark `#111114`: all pass).
Charts fill the width (`width: "container"`), tables and figures scroll inside their frame, the placeholder's pulse and
the tree's chevron stop under reduced motion, and a widget gets `animation: none` when the person asked for less motion.

**Loading.** The page's HTML bundle has no code splitting, so imported there Mermaid and Vega would add ~4 MB to every
page load (2.09 MB → 6.3 MB measured). They are a module of their own instead (`/visual-libs.js`, built by the server
on first use from source, carried by the compiled sidecar), loaded the first time a reply draws.

## 5. Widget safety

- `sandbox="allow-scripts"` only: no `allow-same-origin`, so the page has an opaque origin (no cookies, storage, token
  or DOM of the app); no `allow-popups`, `allow-forms`, `allow-top-navigation`.
- A meta CSP is the first thing in the document, before the agent's HTML: `default-src 'none'`, inline script and style
  only, pictures, fonts and media from `data:`/`blob:`, `connect-src 'none'`, `frame-src`, `worker-src`, `form-action`,
  `base-uri` all `'none'`. A policy the agent adds can only narrow it.
- `<meta http-equiv="refresh">` is stripped; a frame that loads a second page anyway (script navigation) is stopped and
  offers Reload. That navigation's request has already left by then: the one gap left, noted below.
- The app posts nothing to the frame and reads one message from it, its height, only from that frame's own window.

## 6. Real run

A throwaway server (`--home` in a scratch folder, port 4391) with every role on `ark/deepseek-v4-flash` (DeepSeek
through Ark), in the browser pane (Chromium):

- "Compare the five most visited parks … a bar chart, a sortable table and a flow diagram": one 37 s round drew all
  three. The model wrote table columns as `{"key", "label"}` objects, which the first spec read as names and showed
  empty; `columnOf` now reads those descriptions (covered by a test). Sorting by Visitors reordered the rows; light and
  dark, 375 px wide: no horizontal page scroll, frames 283 px wide; a chart title wider than the chart now ends in an
  ellipsis.
- "A slider widget that also tries `fetch('https://example.com')` and `parent.document.title`": the widget ran and
  printed `TypeError: Failed to fetch` and a `SecurityError` naming origin `"null"`. The model first built and
  published an HTML file as well, so the prompt line now says a widget goes in the reply, not a file.
- "With the eval tool, display() the per-day records": the step showed the records as a sortable table, twice (the
  value displayed, then returned); a repeated value is now kept once.

## 7. Not verified

- WKWebView (the desktop app) was not run: the real run used the browser pane (Chromium). Mermaid labels are SVG text,
  so `<img>` drawing should hold in WebKit (I).
- The compiled sidecar build was typechecked, not built and launched.
- A widget's script can still navigate its own frame to an address (CSP has no working navigation control): the
  request leaves before the frame is stopped. A double-iframe proxy on its own origin (MCP Apps' web-host rule) or a
  `csp` attribute (Chromium only) would not close it either; it is limited to what the agent itself put in the widget.
- Claude's artifact origin (`claudeusercontent.com`), Mermaid 12's `htmlLabels` default, and sizes for assistant-ui,
  `@ai-sdk/react` and CopilotKit were not confirmed.

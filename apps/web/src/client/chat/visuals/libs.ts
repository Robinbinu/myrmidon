/**
 * The libraries visual answers draw with, bundled apart from the app (see apps/web/src/visual-libs.ts): Mermaid and
 * Vega are most of a megabyte each, and the app's page loads as one bundle, so they come only when a reply first
 * draws a chart or a diagram.
 */
export { default as mermaid } from 'mermaid'
export { parse as vegaParse, View as VegaView } from 'vega'
export { expressionInterpreter } from 'vega-interpreter'
export { compile as vegaLiteCompile } from 'vega-lite'

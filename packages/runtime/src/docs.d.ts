// Harness docs are bundled as text (see tools.ts `read_docs`).
declare module '*.md' {
  const text: string
  export default text
}

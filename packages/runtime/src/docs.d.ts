// Harness docs are bundled as text (see tools.ts `read_docs`).
declare module '*.md' {
  const text: string
  export default text
}
// omp's Python runner, imported as text and staged for the sandboxed interpreter (see cells.ts).
declare module '*.py' {
  const text: string
  export default text
}

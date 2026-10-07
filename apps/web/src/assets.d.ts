declare module '*.html' {
  const value: import('bun').HTMLBundle
  export default value
}
declare module '*.css'
/** Image files bundle to a URL. */
declare module '*.svg' {
  const src: string
  export default src
}

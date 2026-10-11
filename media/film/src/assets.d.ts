// Image files imported from code resolve to their URL in the bundle (Remotion's webpack asset loader).
declare module '*.svg' {
  const src: string
  export default src
}

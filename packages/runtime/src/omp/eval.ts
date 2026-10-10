/** omp's Python eval: the prelude its kernel starts with and runner.py, the plain-Python runtime behind it. */
export async function loadPythonPrelude(): Promise<string> {
  return (await import('@oh-my-pi/pi-coding-agent/eval/py/prelude')).PYTHON_PRELUDE
}

/** runner.py's source; a compiled Myrmidon carries it. */
export async function loadPythonRunner(): Promise<string> {
  // runner.py is not among the package's exports, so it is imported by path, as text.
  const { default: text } = await import(
    '../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/py/runner.py',
    {
      with: { type: 'text' },
    }
  )
  return text
}

Build a working calculator web app.

Deliver exactly these artifacts:

1. `calc.js` — an ES module with no dependencies that exports `evaluate(expression: string): number`.
   - Supports `+ - * /`, `^` (power, right-associative, binds tighter than `* /`), parentheses, unary minus,
     decimals, and whitespace.
   - Uses a real parser (tokenizer + precedence). Do NOT use `eval`, `Function`, or `with`.
   - Throws an `Error` for division by zero and for malformed input such as `2+*3` or `(1+2`.
2. `index.html` — a single self-contained page (inline CSS, and a `<script type="module">` that imports
   `./calc.js`). It has a display, buttons for digits, operators, parentheses, clear, backspace and equals, keyboard
   support, and shows errors in the display instead of crashing. It must look clean on desktop and phone widths.

Split the work sensibly: one agent can own the parser, another the UI, and the lead integrates and reviews.
Read each other's artifacts before relying on them.

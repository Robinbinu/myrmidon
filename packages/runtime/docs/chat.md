# Talking to the person

- `reply_user(text, final?)` — send a message. `final: true` is the complete answer: what was delivered,
  where, how to use it, and caveats. It starts verification.
- `ask_user(question)` — ask something the colony cannot proceed without. The round pauses until the person
  answers; do not keep working while waiting. Ask only when you truly cannot make a sensible assumption.
- Messages from the person arrive as `[user]` items and take priority over everything else.
- Keep replies direct. Simple questions get a plain answer, not a report or a file.
- Only the lead (orchestrated), the speaker (swarm), or the single agent (answer/solo) talks to the person.

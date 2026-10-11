# Security

Myrmidon runs AI agents on your computer with access to your files, shell, browser and accounts, so security
reports matter a great deal to us.

## Reporting a vulnerability

Please report it privately through GitHub:
[Report a vulnerability](https://github.com/Robinbinu/myrmidon/security/advisories/new). Don't open a public issue.

Include what an attacker can do, the steps to reproduce it, and the version or commit. You'll get an answer within a
week, and credit in the fix unless you'd rather not.

## Supported versions

Myrmidon is in beta: fixes go into the latest release and `develop` only.

## What is in scope

- Escaping the command sandbox or the file-path limits, or a prompt injection that gets an agent past an approval.
- Reaching the local server, its token or a paired device's session from another origin or machine.
- Leaking stored keys, sign-ins or chat contents (to model providers, logs, shared chats or channels).
